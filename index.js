const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { makeWASocket, DisconnectReason, proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || 'https://jcnsepbalxyscxrsyade.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_kVLvltX-K4yGF2VRPaGDaA_KBkmT78W';
const supabase = createClient(supabaseUrl, supabaseKey);

const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || 'https://crm-dcam-produccion.vercel.app/api/whatsapp-webhook';
const AI_EXTRACT_URL = process.env.AI_EXTRACT_URL || 'https://crm-dcam-produccion.vercel.app/api/ai-extract';

let sock;
let currentQR = '';

// Adaptador de Baileys para almacenar la sesión en Supabase
async function useSupabaseAuthState() {
  const readData = async (key) => {
    try {
      const { data, error } = await supabase
        .from('whatsapp_auth')
        .select('value')
        .eq('key', key)
        .maybeSingle();

      if (error || !data) return null;
      return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const writeData = async (key, value) => {
    try {
      const parsedValue = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
      await supabase
        .from('whatsapp_auth')
        .upsert({ key, value: parsedValue }, { onConflict: 'key' });
    } catch (error) {
      console.error('Error guardando en Supabase auth:', error);
    }
  };

  const removeData = async (key) => {
    try {
      await supabase.from('whatsapp_auth').delete().eq('key', key);
    } catch (error) {
      console.error('Error eliminando de Supabase auth:', error);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                await writeData(key, value);
              } else {
                await removeData(key);
              }
            }
          }
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

async function askSolAI(conversationHistory) {
  try {
    const res = await fetch(AI_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory })
    });
    return await res.json();
  } catch (err) {
    console.error('Error llamando a Sol AI:', err.message);
    return null;
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState();

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) currentQR = await QRCode.toDataURL(qr);

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Conectado exitosamente y persistido en BD');
      currentQR = 'CONNECTED';
    }
  });

  // Escuchar mensajes entrantes y despachar al CRM + Sol
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const rawJid = msg.key.remoteJid || '';
        
        if (rawJid.includes('@g.us') || rawJid.includes('@broadcast') || rawJid === 'status@broadcast') {
          continue;
        }

        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     (msg.message.imageMessage ? '📷 Imagen recibida' : '') ||
                     (msg.message.documentMessage ? `📄 Documento PDF: ${msg.message.documentMessage.fileName || 'archivo.pdf'}` : '');
        
        if (!text) continue;

        const cleanPhone = rawJid.replace(/\D/g, '');
        const name = msg.pushName || `+${cleanPhone}`;
        const displayPhone = `+${cleanPhone}`;

        // 1. Persistencia en Supabase
        let { data: contact } = await supabase
          .from('contacts')
          .select('*')
          .or(`jid.eq.${rawJid},phone.eq.${displayPhone}`)
          .maybeSingle();

        if (!contact) {
          const { data: newContact } = await supabase
            .from('contacts')
            .insert([{ 
              name, 
              phone: displayPhone, 
              jid: rawJid,
              status: 'entrante', 
              last_message: text 
            }])
            .select()
            .single();
          contact = newContact;
        } else {
          await supabase
            .from('contacts')
            .update({ 
              last_message: text,
              jid: rawJid,
              name: (contact.name === contact.phone || !contact.name) ? name : contact.name,
              updated_at: new Date().toISOString() 
            })
            .eq('id', contact.id);
        }

        if (contact) {
          await supabase.from('messages').insert([{
            contact_id: contact.id,
            sender: 'client',
            text: text
          }]);
        }

        // 2. Notificar al CRM en Vercel
        try {
          const crmRes = await fetch(CRM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: cleanPhone, name, text, sender: 'client' })
          });
          const crmData = await crmRes.json();
          const conv = crmData?.conversation;

          // Si Sol está en pausa en el CRM, no responde
          if (conv && conv.botActive === false) {
            console.log(`Sol en pausa para ${name}`);
            continue;
          }

          // 3. Respuesta automática con Sol AI
          const history = conv?.messages?.length ? conv.messages : [{ sender: 'client', text }];
          const aiData = await askSolAI(history);

          if (aiData?.replyMessage) {
            // Responder por WhatsApp
            await sock.sendMessage(rawJid, { text: aiData.replyMessage });

            // Registrar en Supabase
            if (contact) {
              await supabase.from('messages').insert([{
                contact_id: contact.id,
                sender: 'me',
                text: aiData.replyMessage
              }]);
            }

            // Registrar respuesta y ficha técnica en el CRM
            await fetch(CRM_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phone: cleanPhone,
                text: aiData.replyMessage,
                sender: 'me',
                extractedData: aiData.extractedData || null
              })
            });
          }
        } catch (crmErr) {
          console.error('Error enviando al CRM:', crmErr.message);
        }
      }
    }
  });
}

connectToWhatsApp();

app.get('/', (req, res) => res.send('<h2>✅ Servidor WhatsApp DCAM Online y Conectado al CRM</h2>'));

app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') return res.send('<h2>✅ WhatsApp ya está conectado</h2>');
  if (!currentQR) return res.send('<h2>Generando QR, recarga en unos segundos...</h2>');
  res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
    <h2>Escaneá con tu WhatsApp</h2>
    <img src="${currentQR}" style="width:300px;height:300px;"/>
  </div>`);
});

// Endpoint unificado para envíos manuales desde el CRM y proyectos anteriores
async function handleSend(req, res) {
  const { phone, jid, message, imageUrl } = req.body;
  if ((!phone && !jid) || !sock) {
    return res.status(400).json({ error: 'Faltan parámetros o WhatsApp desconectado' });
  }

  try {
    let targetJid = jid;
    if (!targetJid) {
      const cleanDigits = phone.replace(/[^0-9]/g, '');
      targetJid = `${cleanDigits}@s.whatsapp.net`;
    }

    if (imageUrl) {
      await sock.sendMessage(targetJid, { 
        image: { url: imageUrl }, 
        caption: message || '' 
      });
    } else {
      await sock.sendMessage(targetJid, { text: message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error enviando:', error);
    res.status(500).json({ error: error.message });
  }
}

app.post('/send-message', handleSend);
app.post('/send', handleSend);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));