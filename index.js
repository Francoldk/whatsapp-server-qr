const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://jcnsepbalxyscxrsyade.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_kVLvltX-K4yGF2VRPaGDaA_KBkmT78W';
const supabase = createClient(supabaseUrl, supabaseKey);

let sock;
let currentQR = '';

// Extraer número de teléfono real resolviendo el LID de WhatsApp
function extractRealPhoneNumber(msg) {
  const remoteJid = msg.key.remoteJid || '';
  
  // Ignorar grupos y difusiones/estados
  if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid === 'status@broadcast') {
    return null;
  }

  // 1. WhatsApp envía el número real en senderPn cuando usa LID
  let rawPn = msg.key.senderPn || msg.senderPn || msg.key.participantPn;

  // 2. Si no viene senderPn pero el remoteJid es el formato clásico
  if (!rawPn && remoteJid.endsWith('@s.whatsapp.net')) {
    rawPn = remoteJid;
  }

  // 3. Fallback
  if (!rawPn) {
    rawPn = remoteJid;
  }

  const cleanDigits = rawPn.split('@')[0].replace(/[^0-9]/g, '');
  if (!cleanDigits) return null;

  return '+' + cleanDigits;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Conectado exitosamente');
      currentQR = 'CONNECTED';
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const phone = extractRealPhoneNumber(msg);
        if (!phone) continue; // Si es grupo o estado, ignorar

        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     (msg.message.imageMessage ? '📷 Imagen recibida' : '');
        
        const name = msg.pushName || phone;

        if (!text) continue;

        // 1. Buscar contacto por número exacto o por últimos 8 dígitos (evita duplicados por prefijo)
        let { data: contact } = await supabase
          .from('contacts')
          .select('*')
          .eq('phone', phone)
          .maybeSingle();

        if (!contact) {
          const last8 = phone.slice(-8);
          const { data: allContacts } = await supabase.from('contacts').select('*');
          contact = allContacts?.find(c => c.phone && c.phone.replace(/[^0-9]/g, '').endsWith(last8));
        }

        if (!contact) {
          // Si es un contacto totalmente nuevo, crearlo en ENTRANTE
          const { data: newContact } = await supabase
            .from('contacts')
            .insert([{ name, phone, status: 'entrante', last_message: text }])
            .select()
            .single();
          contact = newContact;
        } else {
          // Si ya existe, actualizar su último mensaje sin moverlo de columna
          await supabase
            .from('contacts')
            .update({ 
              last_message: text, 
              name: (contact.name === contact.phone || !contact.name) ? name : contact.name,
              updated_at: new Date().toISOString() 
            })
            .eq('id', contact.id);
        }

        // 2. Guardar mensaje en la conversación
        if (contact) {
          await supabase.from('messages').insert([{
            contact_id: contact.id,
            sender: 'client',
            text: text
          }]);
        }
      }
    }
  });
}

connectToWhatsApp();

// Endpoint para ver el QR en el navegador
app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') {
    return res.send('<h2>✅ WhatsApp ya está conectado</h2>');
  }
  if (!currentQR) {
    return res.send('<h2>Generando QR, recarga en unos segundos...</h2>');
  }
  res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
    <h2>Escaneá con tu WhatsApp</h2>
    <img src="${currentQR}" style="width:300px;height:300px;"/>
  </div>`);
});

// Endpoint para enviar mensajes e imágenes desde tu CRM
app.post('/send-message', async (req, res) => {
  const { phone, message, imageUrl } = req.body;
  if (!phone || !sock) {
    return res.status(400).json({ error: 'Faltan parámetros o socket no listo' });
  }

  try {
    const formattedPhone = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    
    if (imageUrl) {
      await sock.sendMessage(formattedPhone, { 
        image: { url: imageUrl }, 
        caption: message || '' 
      });
    } else {
      await sock.sendMessage(formattedPhone, { text: message });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));