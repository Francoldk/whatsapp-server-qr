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
        const phone = '+' + msg.key.remoteJid.split('@')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const name = msg.pushName || phone;

        if (!text) continue;

        // 1. Buscar o crear contacto en Supabase
        let { data: contact } = await supabase
          .from('contacts')
          .select('*')
          .eq('phone', phone)
          .single();

        if (!contact) {
          const { data: newContact } = await supabase
            .from('contacts')
            .insert([{ name, phone, status: 'entrante', last_message: text }])
            .select()
            .single();
          contact = newContact;
        } else {
          await supabase
            .from('contacts')
            .update({ last_message: text, updated_at: new Date().toISOString() })
            .eq('id', contact.id);
        }

        // 2. Guardar mensaje en la tabla messages
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

// Endpoint para enviar mensajes desde tu CRM
app.post('/send-message', async (req, res) => {
  const { phone, message, imageUrl } = req.body;
  if (!phone || !sock) {
    return res.status(400).json({ error: 'Faltan parámetros o socket no listo' });
  }

  try {
    const formattedPhone = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    
    // Si viene una imagen, manda la foto a WhatsApp con el texto como pie de foto
    if (imageUrl) {
      await sock.sendMessage(formattedPhone, { 
        image: { url: imageUrl }, 
        caption: message || '' 
      });
    } else {
      // Si no hay imagen, manda solo el texto tradicional
      await sock.sendMessage(formattedPhone, { text: message });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));