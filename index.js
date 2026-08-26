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

  // Escuchar mensajes entrantes
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
                     (msg.message.imageMessage ? '📷 Imagen recibida' : '');
        
        if (!text) continue;

        const name = msg.pushName || (rawJid.endsWith('@s.whatsapp.net') ? '+' + rawJid.split('@')[0] : 'Contacto WhatsApp');
        const displayPhone = rawJid.endsWith('@s.whatsapp.net') ? '+' + rawJid.split('@')[0] : name;

        let { data: contact } = await supabase
          .from('contacts')
          .select('*')
          .or(`jid.eq.${rawJid},phone.eq.${displayPhone}`)
          .maybeSingle();

        if (!contact) {
          const { data: newContact } = await supabase
            .from('contacts')
            .insert([{ 
              name: msg.pushName || displayPhone, 
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
      }
    }
  });
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') return res.send('<h2>✅ WhatsApp ya está conectado</h2>');
  if (!currentQR) return res.send('<h2>Generando QR, recarga en unos segundos...</h2>');
  res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
    <h2>Escaneá con tu WhatsApp</h2>
    <img src="${currentQR}" style="width:300px;height:300px;"/>
  </div>`);
});

app.post('/send-message', async (req, res) => {
  const { phone, jid, message, imageUrl } = req.body;
  if ((!phone && !jid) || !sock) {
    return res.status(400).json({ error: 'Faltan parámetros o socket no listo' });
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
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));