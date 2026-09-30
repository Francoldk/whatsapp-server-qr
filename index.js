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

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

const supabaseUrl = process.env.SUPABASE_URL || 'https://jcnsepbalxyscxrsyade.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_kVLvltX-K4yGF2VRPaGDaA_KBkmT78W';
const supabase = createClient(supabaseUrl, supabaseKey);

const AI_EXTRACT_URL = process.env.AI_EXTRACT_URL || 'https://crm-whatsapp-simple-1.vercel.app/api/ai-extract';

let sock = null;
let currentQR = '';

// 🔥 Memoria temporal para no duplicar los mensajes que enviamos desde el CRM
const apiSentMessages = new Set();

async function useSupabaseAuthState() {
  const readData = async (key) => {
    try {
      const { data, error } = await supabase.from('whatsapp_auth').select('value').eq('key', key).maybeSingle();
      if (error || !data) return null;
      return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
    } catch (error) { return null; }
  };
  const writeData = async (key, value) => {
    try {
      const parsedValue = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
      await supabase.from('whatsapp_auth').upsert({ key, value: parsedValue }, { onConflict: 'key' });
    } catch (error) {}
  };
  const removeData = async (key) => {
    try { await supabase.from('whatsapp_auth').delete().eq('key', key); } catch (error) {}
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
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) await writeData(key, value);
              else await removeData(key);
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
    const payload = { conversationHistory };
    if (imageBase64) payload.imageBase64 = imageBase64;
    const res = await fetch(AI_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) { return null; }
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
      if (qr) currentQR = await QRCode.toDataURL(qr);
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
        else { currentQR = ''; setTimeout(connectToWhatsApp, 2000); }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp CONECTADO exitosamente');
        currentQR = 'CONNECTED';
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const isFromMe = msg.key.fromMe;
        const msgId = msg.key.id;
        const rawJid = msg.key.remoteJid || '';
        if (rawJid.includes('@g.us') || rawJid.includes('@broadcast') || rawJid === 'status@broadcast') continue;

        // Si el mensaje lo enviamos desde el CRM recién, lo ignoramos acá para no guardarlo doble en Supabase
        if (isFromMe && apiSentMessages.has(msgId)) {
            apiSentMessages.delete(msgId);
            continue;
        }

        let imageBase64 = null;
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (msg.message.imageMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            imageBase64 = buffer.toString('base64');
            text = msg.message.imageMessage.caption || 'Adjunto foto.';
          } catch (err) { text = '📷 Imagen recibida'; }
        } else if (msg.message.documentMessage) {
          text = `📄 Documento: ${msg.message.documentMessage.fileName || 'archivo'}`;
        }
        
        if (!text && !imageBase64) continue;

        const cleanPhone = rawJid.replace(/\D/g, '');
        const name = msg.pushName || `+${cleanPhone}`;
        const displayPhone = `+${cleanPhone}`;

        // 1. Guardar en Base de Datos (captura tus mensajes del celular y los del cliente)
        let contact = null;
        try {
          const { data: existing } = await supabase.from('contacts').select('*').or(`jid.eq.${rawJid},phone.eq.${displayPhone}`).maybeSingle();
          if (!existing) {
            const { data: created } = await supabase.from('contacts').insert([{
              name, phone: displayPhone, jid: rawJid, status: 'Nuevo Lead', last_message: text, bot_active: true
            }]).select().single();
            contact = created;
          } else {
            const { data: updated } = await supabase.from('contacts').update({
              last_message: text, jid: rawJid, name: (existing.name === existing.phone || !existing.name) ? name : existing.name, updated_at: new Date().toISOString()
            }).eq('id', existing.id).select().single();
            contact = updated;
          }

          if (contact) {
            await supabase.from('messages').insert([{
              contact_id: contact.id,
              sender: isFromMe ? 'me' : 'client',
              text: text
            }]);
          }
        } catch (dbErr) { console.error('Error DB Supabase:', dbErr.message); }

        // 🛑 CRÍTICO: Si el mensaje lo mandaste VOS desde el celu, frenamos acá. No consultamos a la IA.
        if (isFromMe) continue;

        if (contact && contact.bot_active === false) continue;

        // 2. Procesamiento de Sol AI (Solo responde al cliente)
        try {
          const aiData = await askSolAI([{ sender: 'client', text }], imageBase64);
          if (aiData?.replyMessage) {
            await sock.sendMessage(rawJid, { text: aiData.replyMessage });
            if (contact) {
              await supabase.from('messages').insert([{ contact_id: contact.id, sender: 'me', text: aiData.replyMessage }]);
              const updatePayload = { last_message: aiData.replyMessage, updated_at: new Date().toISOString() };
              if (aiData.extractedData) updatePayload.quote_data = { ...(contact.quote_data || {}), ...aiData.extractedData };
              if (aiData.suggestedStatus) updatePayload.status = aiData.suggestedStatus;
              await supabase.from('contacts').update(updatePayload).eq('id', contact.id);
            }
          }
        } catch (aiErr) {}
      }
    });
  } catch (err) { setTimeout(connectToWhatsApp, 5000); }
}

connectToWhatsApp();

app.get('/', (req, res) => res.send('<h2>✅ Servidor WhatsApp DCAM Online</h2>'));
app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') return res.send('<h2>✅ WhatsApp ya está conectado</h2>');
  if (!currentQR) return res.send('<h2>Generando QR, recarga...</h2><script>setTimeout(()=>location.reload(),3000);</script>');
  res.send(`<h2>Escaneá el QR</h2><img src="${currentQR}" style="width:320px;height:320px;"/>`);
});

// Endpoint para envíos manuales desde el CRM Vercel
async function handleSend(req, res) {
  const { phone, jid, message, imageUrl } = req.body;
  if ((!phone && !jid) || !sock) return res.status(400).json({ error: 'Faltan parámetros' });

  try {
    let targetJid = jid;
    if (!targetJid) {
      const cleanDigits = phone.replace(/[^0-9]/g, '');
      targetJid = `${cleanDigits}@s.whatsapp.net`;
    }

    // 🔥 FIX DEL 9 ARGENTINO: Buscamos el JID real que Baileys registró en la DB
    const cleanPhoneStr = phone ? phone.replace(/\D/g, '') : targetJid.replace(/\D/g, '');
    const { data: contact } = await supabase
      .from('contacts')
      .select('jid')
      .or(`phone.eq.+${cleanPhoneStr},jid.eq.${targetJid}`)
      .maybeSingle();

    if (contact && contact.jid) {
      targetJid = contact.jid; 
    }

    let sentMsg;
    if (imageUrl) {
      sentMsg = await sock.sendMessage(targetJid, { image: { url: imageUrl }, caption: message || '' });
    } else {
      sentMsg = await sock.sendMessage(targetJid, { text: message });
    }

    // Anotamos el ID del mensaje para que la función upsert de arriba NO lo duplique en la base de datos (Vercel ya lo guardó)
    if (sentMsg && sentMsg.key && sentMsg.key.id) {
      apiSentMessages.add(sentMsg.key.id);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

app.post('/send-message', handleSend);
app.post('/send', handleSend);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));