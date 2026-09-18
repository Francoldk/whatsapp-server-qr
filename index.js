const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { 
  makeWASocket, 
  DisconnectReason, 
  proto, 
  initAuthCreds, 
  BufferJSON, 
  downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const app = express();

// Middlewares y cabeceras CORS explícitas
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

const supabaseUrl = process.env.SUPABASE_URL || 'https://jcnsepbalxyscxrsyade.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_kVLvltX-K4yGF2VRPaGDaA_KBkmT78W';
const supabase = createClient(supabaseUrl, supabaseKey);

// URL de producción en Vercel
const AI_EXTRACT_URL = process.env.AI_EXTRACT_URL || 'https://crm-whatsapp-simple-1.vercel.app/api/ai-extract';

let sock = null;
let currentQR = '';

// Adaptador de autenticación persistente con Supabase
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
      console.error('Error guardando en Supabase:', error.message);
    }
  };

  const removeData = async (key) => {
    try {
      await supabase.from('whatsapp_auth').delete().eq('key', key);
    } catch (error) {
      console.error('Error eliminando en Supabase:', error.message);
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

async function askSolAI(conversationHistory, imageBase64 = null) {
  try {
    console.log('🤖 Consultando a Sol AI (multimodal)...');
    const payload = { conversationHistory };
    if (imageBase64) {
      payload.imageBase64 = imageBase64;
    }

    const res = await fetch(AI_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`❌ Sol AI respondió con estado ${res.status}`);
      return null;
    }

    const data = await res.json();
    console.log('✅ Respuesta de Sol AI recibida:', data?.replyMessage);
    return data;
  } catch (err) {
    console.error('❌ Error de conexión con Sol AI:', err.message);
    return null;
  }
}

async function connectToWhatsApp() {
  console.log('🚀 Iniciando Baileys conectado a Supabase...');
  try {
    const { state, saveCreds } = await useSupabaseAuthState();

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['DCAM Official', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        console.log(`❌ Conexión cerrada. Código: ${statusCode}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(connectToWhatsApp, 3000);
        } else {
          currentQR = '';
          setTimeout(connectToWhatsApp, 2000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp CONECTADO exitosamente');
        currentQR = 'CONNECTED';
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const rawJid = msg.key.remoteJid || '';
          if (rawJid.includes('@g.us') || rawJid.includes('@broadcast') || rawJid === 'status@broadcast') continue;

          let imageBase64 = null;
          let text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

          // Descarga directa del archivo de imagen para procesamiento con Groq
          if (msg.message.imageMessage) {
            try {
              const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { logger: pino({ level: 'silent' }) }
              );
              imageBase64 = buffer.toString('base64');
              text = msg.message.imageMessage.caption || 'Adjunto foto del producto o etiqueta para cotizar.';
            } catch (mediaErr) {
              console.error('Error descargando imagen de WhatsApp:', mediaErr.message);
              text = '📷 Imagen recibida';
            }
          } else if (msg.message.documentMessage) {
            text = `📄 Documento PDF: ${msg.message.documentMessage.fileName || 'archivo.pdf'}`;
          }
          
          if (!text && !imageBase64) continue;

          const cleanPhone = rawJid.replace(/\D/g, '');
          const name = msg.pushName || `+${cleanPhone}`;
          const displayPhone = `+${cleanPhone}`;

          console.log(`📩 Mensaje de ${name} (${displayPhone}): ${text} ${imageBase64 ? '[FOTO ADJUNTA]' : ''}`);

          // 1. Persistencia en Supabase
          let contact = null;
          try {
            const { data: existing } = await supabase
              .from('contacts')
              .select('*')
              .or(`jid.eq.${rawJid},phone.eq.${displayPhone}`)
              .maybeSingle();

            if (!existing) {
              const { data: created, error: errInsert } = await supabase
                .from('contacts')
                .insert([{
                  name,
                  phone: displayPhone,
                  jid: rawJid,
                  status: 'Nuevo Lead',
                  last_message: text,
                  bot_active: true
                }])
                .select()
                .single();

              if (errInsert) console.error('Error insertando contacto:', errInsert.message);
              contact = created;
            } else {
              const { data: updated, error: errUpdate } = await supabase
                .from('contacts')
                .update({
                  last_message: text,
                  jid: rawJid,
                  name: (existing.name === existing.phone || !existing.name) ? name : existing.name,
                  updated_at: new Date().toISOString()
                })
                .eq('id', existing.id)
                .select()
                .single();

              if (errUpdate) console.error('Error actualizando contacto:', errUpdate.message);
              contact = updated;
            }

            if (contact) {
              await supabase.from('messages').insert([{
                contact_id: contact.id,
                sender: 'client',
                text: text
              }]);
            }
          } catch (dbErr) {
            console.error('Error DB Supabase:', dbErr.message);
          }

          if (contact && contact.bot_active === false) {
            console.log(`⏸️ Sol en pausa para ${name}`);
            continue;
          }

          // 2. Procesamiento de Sol AI con imagen
          try {
            const aiData = await askSolAI([{ sender: 'client', text }], imageBase64);

            if (aiData?.replyMessage) {
              await sock.sendMessage(rawJid, { text: aiData.replyMessage });

              if (contact) {
                await supabase.from('messages').insert([{
                  contact_id: contact.id,
                  sender: 'me',
                  text: aiData.replyMessage
                }]);

                const updatePayload = {
                  last_message: aiData.replyMessage,
                  updated_at: new Date().toISOString()
                };

                if (aiData.extractedData) {
                  updatePayload.quote_data = {
                    ...(contact.quote_data || {}),
                    ...aiData.extractedData
                  };
                }
                if (aiData.suggestedStatus) {
                  updatePayload.status = aiData.suggestedStatus;
                }

                await supabase.from('contacts').update(updatePayload).eq('id', contact.id);
              }
            }
          } catch (aiErr) {
            console.error('Error procesando respuesta de Sol AI:', aiErr.message);
          }
        }
      }
    });

  } catch (err) {
    console.error('Error inicializando Baileys:', err.message);
    setTimeout(connectToWhatsApp, 5000);
  }
}

connectToWhatsApp();

app.get('/', (req, res) => {
  res.send('<h2>✅ Servidor WhatsApp DCAM Online y Conectado a Supabase</h2>');
});

app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') {
    return res.send('<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h2 style="color:#059669;">✅ WhatsApp ya está conectado</h2></div>');
  }
  if (!currentQR) {
    return res.send('<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h2>Generando QR, recarga en unos segundos...</h2><script>setTimeout(()=>location.reload(),3000);</script></div>');
  }
  res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
    <h2>Escaneá con el WhatsApp Oficial de DCAM</h2>
    <img src="${currentQR}" style="width:320px;height:320px;border: 1px solid #ccc; border-radius: 8px;"/>
  </div>`);
});

// Endpoint para envíos manuales
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

    try {
      const cleanPhone = targetJid.replace(/\D/g, '');
      const displayPhone = `+${cleanPhone}`;
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .or(`jid.eq.${targetJid},phone.eq.${displayPhone}`)
        .maybeSingle();

      if (contact) {
        await supabase.from('messages').insert([{
          contact_id: contact.id,
          sender: 'me',
          text: message || (imageUrl ? '📷 Imagen enviada' : '')
        }]);

        await supabase.from('contacts').update({
          last_message: message || (imageUrl ? '📷 Imagen enviada' : ''),
          updated_at: new Date().toISOString()
        }).eq('id', contact.id);
      }
    } catch (dbSaveErr) {
      console.error('Aviso Supabase envío manual:', dbSaveErr.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

app.post('/send-message', handleSend);
app.post('/send', handleSend);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));