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
app.options('/{*splat}', cors());

const supabaseUrl = process.env.SUPABASE_URL || 'https://jcnsepbalxyscxrsyade.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_kVLvltX-K4yGF2VRPaGDaA_KBkmT78W';
const supabase = createClient(supabaseUrl, supabaseKey);
const mediaDb = process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
const { randomUUID } = require('crypto');

// URL de producción en Vercel
const AI_EXTRACT_URL = process.env.AI_EXTRACT_URL || 'https://crm-whatsapp-simple-1.vercel.app/api/ai-extract';

let sock = null;
let currentQR = '';
let groqBackoffUntil = 0;
const solPendingContacts = new Set();

// Distingue envíos de este servidor de mensajes escritos en el celular.
const serverSentIds = new Map();
const serverSentTexts = new Map();
const seenEvents = new Map();
function remember(map, key, ttl = 180000) {
  if (!key) return;
  map.set(key, Date.now() + ttl);
  if (map.size > 1500) {
    for (const [k, until] of map) if (until < Date.now()) map.delete(k);
  }
}
function remembered(map, key) {
  const until = map.get(key);
  if (!until) return false;
  if (until < Date.now()) { map.delete(key); return false; }
  return true;
}
function markServerSent(sent, jid, text) {
  remember(serverSentIds, sent?.key?.id, 300000);
  if (text) remember(serverSentTexts, `${jid}|${text}`, 90000);
}
function unwrapMessage(msg) {
  let body = msg?.message || {};
  for (let i = 0; i < 4; i++) {
    const nested = body.ephemeralMessage?.message ||
      body.viewOnceMessage?.message || body.viewOnceMessageV2?.message ||
      body.documentWithCaptionMessage?.message;
    if (!nested) break;
    body = nested;
  }
  return body;
}
async function transcribeAudio(msg) {
  if (!process.env.GROQ_API_KEY) {
    console.error('🎤 Falta GROQ_API_KEY en Render: no se puede transcribir');
    return null;
  }
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock?.updateMediaMessage?.bind(sock)
    });
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'nota-voz.ogg');
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Whisper HTTP ${response.status}: ${err.slice(0, 250)}`);
    }
    const payload = await response.json();
    return String(payload.text || '').trim() || null;
  } catch (error) {
    console.error('🎤 Error transcribiendo audio:', error.message);
    return null;
  }
}
// Archivos adjuntos guardados en bucket privado de Supabase.
async function storeWhatsAppMedia(msg, body, jid) {
  const entry = body.audioMessage || body.imageMessage || body.documentMessage || body.videoMessage;
  if (!entry) return null;
  if (!mediaDb) {
    console.error('Adjunto no guardado: falta SUPABASE_SERVICE_ROLE_KEY en Render');
    return null;
  }
  const mediaType = body.audioMessage ? 'audio' : body.imageMessage ? 'image' : body.videoMessage ? 'video' : 'document';
  const type = entry.mimetype || (mediaType === 'audio' ? 'audio/ogg' : 'application/octet-stream');
  const extension = mediaType === 'audio' ? (type.includes('mp4') ? 'm4a' : 'ogg') :
    mediaType === 'image' ? (type.includes('png') ? 'png' : 'jpg') : mediaType === 'video' ? 'mp4' : 'bin';
  const name = String(entry.fileName || `${mediaType}-${Date.now()}.${extension}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock?.updateMediaMessage?.bind(sock)
    });
    if (!buffer?.length || buffer.length > 20 * 1024 * 1024) {
      console.error('Adjunto no guardado: vacío o supera 20 MB');
      return null;
    }
    const path = `whatsapp/${jid.split('@')[0]}/${randomUUID()}-${name}`;
    const { error } = await mediaDb.storage.from('chat-media').upload(path, buffer, { contentType: type });
    if (error) throw error;
    return { media_path: path, media_type: mediaType, media_name: name, media_mime: type };
  } catch (err) {
    console.error('Error guardando adjunto WhatsApp:', err.message);
    return null;
  }
}
async function saveMessageInCRM({ rawJid, name, text, fromMe, media = null }) {
  const digits = rawJid.split('@')[0].replace(/\D/g, '');
  const phone = `+${digits}`;
  const { data: existing, error: lookupError } = await supabase.from('contacts')
    .select('*').or(`jid.eq.${rawJid},phone.eq.${phone}`).maybeSingle();
  if (lookupError) throw lookupError;
  let contact = existing;
  if (!contact) {
    const { data, error } = await supabase.from('contacts').insert([{
      name: name || phone, phone, jid: rawJid, status: 'Entrante',
      last_message: text, bot_active: true
    }]).select().single();
    if (error) throw error;
    contact = data;
  }
  const { error: insertError } = await supabase.from('messages').insert([{
    contact_id: contact.id, sender: fromMe ? 'me' : 'client', text, ...(media || {})
  }]);
  if (insertError) throw insertError;
  const { error: updateError } = await supabase.from('contacts').update({
    last_message: text, jid: rawJid,
    name: !fromMe && (!contact.name || contact.name === contact.phone) ? name : contact.name,
    updated_at: new Date().toISOString()
  }).eq('id', contact.id);
  if (updateError) console.error('Error actualizando contacto:', updateError.message);
  return contact;
}


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

async function askSolAI(conversationHistory, imageBase64 = null, quoteData = {}) {
  if (Date.now() < groqBackoffUntil) return null;
  try {
    console.log('🤖 Consultando a Sol AI (multimodal)...');
    const payload = { conversationHistory: conversationHistory.slice(-10), quoteData };
    if (imageBase64) {
      payload.imageBase64 = imageBase64;
    }

    const res = await fetch(AI_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      if (res.status === 429) {
        let detail = {};
        try { detail = await res.json(); } catch (_) {}
        const delay = Math.max(10, Math.min(120, Number(detail.retryAfter || res.headers.get('retry-after') || 30)));
        groqBackoffUntil = Date.now() + delay * 1000;
        console.warn(`⏳ Groq 429: pausa global de ${delay} segundos; no se enviará una respuesta repetida.`);
        return null;
      }
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
      // notify: eventos en vivo. append: algunas sincronizaciones desde el celular.
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages || []) {
        try {
          if (!msg?.message) continue;
          const rawJid = msg.key?.remoteJid || '';
          if (!rawJid.endsWith('@s.whatsapp.net') && !rawJid.endsWith('@lid')) continue;
          const fromMe = msg.key.fromMe === true;
          const messageId = `${rawJid}|${msg.key.id || ''}`;
          if (msg.key.id && remembered(seenEvents, messageId)) continue;
          // Evita importar conversaciones antiguas cuando Baileys sincroniza el historial.
          if (type === 'append') {
            if (!fromMe) continue;
            const time = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);
            if (!time || Math.abs(Date.now() / 1000 - time) > 180) continue;
          }
          const body = unwrapMessage(msg);
          let imageBase64 = null;
          let text = body.conversation || body.extendedTextMessage?.text ||
            body.imageMessage?.caption || body.documentMessage?.caption || '';
          if (body.audioMessage) {
            const transcribed = await transcribeAudio(msg);
            text = transcribed ? `🎤 Audio: ${transcribed}` : '🎤 Audio recibido — transcripción no disponible';
          } else if (body.imageMessage) {
            if (!fromMe) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                  logger: pino({ level: 'silent' }),
                  reuploadRequest: sock?.updateMediaMessage?.bind(sock)
                });
                imageBase64 = buffer.toString('base64');
              } catch (e) {
                console.error('Error descargando imagen:', e.message);
              }
            }
            text = text || (fromMe ? '📷 Imagen enviada' : '📷 Imagen recibida');
          } else if (body.documentMessage) {
            text = text || `📄 Documento: ${body.documentMessage.fileName || 'archivo'}`;
          } else if (body.videoMessage) {
            text = text || (fromMe ? '🎬 Video enviado' : '🎬 Video recibido');
          }
          if (!text.trim() && !imageBase64) continue;
          if (fromMe && (remembered(serverSentIds, msg.key.id) || remembered(serverSentTexts, `${rawJid}|${text}`))) {
            if (msg.key.id) remember(seenEvents, messageId);
            continue;
          }
          const media = await storeWhatsAppMedia(msg, body, rawJid);
          const name = msg.pushName || `+${rawJid.split('@')[0]}`;
          // Registrar antes de responder. Los propios NUNCA activan a Sol.
          const contact = await saveMessageInCRM({ rawJid, name, text, fromMe, media });
          if (msg.key.id) remember(seenEvents, messageId);
          console.log(`${fromMe ? '📤 Celular' : '📩 Cliente'}: ${name}: ${text.slice(0, 120)}`);
          if (fromMe || !contact || contact.bot_active === false) continue;
          // El contenido transcrito se incluye como texto y Sol puede interpretarlo.
          if (body.audioMessage && text.includes('transcripción no disponible')) continue;
          if (solPendingContacts.has(contact.id)) {
            console.log('⏭️ Sol ya está procesando este contacto; evito respuesta concurrente');
            continue;
          }
          solPendingContacts.add(contact.id);
          try {
          const { data: recent, error: historyError } = await supabase.from('messages')
            .select('sender,text').eq('contact_id', contact.id)
            .order('created_at', { ascending: false }).limit(10);
          if (historyError) console.error('Error obteniendo historial:', historyError.message);
          const history = recent?.length ? recent.reverse() : [{ sender: 'client', text }];
          const aiData = await askSolAI(history, imageBase64, contact.quote_data || {});
          if (!aiData?.replyMessage) continue;
          // Evitar eco/repetición exacta de una respuesta anterior.
          const previousReply = [...history].reverse().find(m => m.sender === 'me')?.text;
          if (previousReply && previousReply.trim() === aiData.replyMessage.trim()) {
            console.log('⏭️ Sol repitió su respuesta anterior; envío cancelado');
            continue;
          }
          const sent = await sock.sendMessage(rawJid, { text: aiData.replyMessage });
          markServerSent(sent, rawJid, aiData.replyMessage);
          const { error: sentError } = await supabase.from('messages').insert([{
            contact_id: contact.id, sender: 'me', text: aiData.replyMessage
          }]);
          if (sentError) console.error('Error guardando respuesta de Sol:', sentError.message);
          const extracted = Object.fromEntries(Object.entries(aiData.extractedData || {})
            .filter(([, value]) => value != null && value !== ''));
          await supabase.from('contacts').update({
            last_message: aiData.replyMessage,
            updated_at: new Date().toISOString(),
            quote_data: { ...(contact.quote_data || {}), ...extracted },
            ...(aiData.suggestedStatus ? { status: aiData.suggestedStatus } : {})
          }).eq('id', contact.id);
          } finally { solPendingContacts.delete(contact.id); }
        } catch (error) {
          console.error('❌ Error procesando mensaje WhatsApp:', error.message);
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
  const { phone, jid, message, imageUrl, mediaUrl, mediaPath, mediaType, mediaName, mimeType, contactId } = req.body || {};
  if ((!phone && !jid) || !sock) return res.status(400).json({ error: 'WhatsApp desconectado o falta contacto' });
  if (mediaUrl && (!process.env.INTERNAL_MEDIA_SECRET || req.headers['x-media-secret'] !== process.env.INTERNAL_MEDIA_SECRET)) {
    return res.status(403).json({ error: 'Envío multimedia no autorizado' });
  }
  try {
    const targetJid = jid || `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
    let payload;
    let label = String(message || '').trim();
    if (mediaUrl) {
      const host = new URL(mediaUrl).hostname;
      if (host !== new URL(supabaseUrl).hostname) return res.status(400).json({ error: 'Origen multimedia no permitido' });
      if (!['image', 'video', 'audio', 'document'].includes(mediaType) || !mediaPath) {
        return res.status(400).json({ error: 'Multimedia inválida' });
      }
      if (mediaType === 'image') payload = { image: { url: mediaUrl }, caption: label };
      if (mediaType === 'video') payload = { video: { url: mediaUrl }, caption: label };
      if (mediaType === 'audio') payload = { audio: { url: mediaUrl }, mimetype: mimeType || 'audio/mpeg', ptt: false };
      if (mediaType === 'document') payload = { document: { url: mediaUrl }, mimetype: mimeType || 'application/octet-stream', fileName: mediaName || 'archivo', caption: label };
      label = label || `${mediaType === 'audio' ? '🎤' : mediaType === 'image' ? '📷' : mediaType === 'video' ? '🎬' : '📄'} ${mediaName || 'Archivo enviado'}`;
    } else if (mediaPath || mediaType) {
      return res.status(400).json({ error: 'Llegaron datos multimedia incompletos desde Vercel' });
    } else if (imageUrl) {
      payload = { image: { url: imageUrl }, caption: label };
      label = label || '📷 Imagen enviada';
    } else {
      if (!label) return res.status(400).json({ error: 'Mensaje vacío' });
      payload = { text: label };
    }
    // Usar la credencial privada SOLO para esta operación de persistencia;
    // mantener sin cambios el adaptador de autenticación WhatsApp.
    if (!mediaDb) return res.status(503).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Render' });
    const digits = targetJid.split('@')[0].replace(/\D/g, '');
    let found = null;
    if (contactId) {
      const { data, error } = await mediaDb.from('contacts').select('id').eq('id', contactId).maybeSingle();
      if (error) throw new Error(`Buscando contacto: ${error.message}`);
      found = data;
    }
    if (!found) {
      const { data, error } = await mediaDb.from('contacts').select('id')
        .or(`jid.eq.${targetJid},phone.eq.+${digits}`).maybeSingle();
      if (error) throw new Error(`Buscando contacto: ${error.message}`);
      found = data;
    }
    if (!found) return res.status(404).json({ error: 'No se encontró contacto para el adjunto' });
    console.log(`[MEDIA DEBUG] tipo=${mediaType || 'texto'} adjunto=${!!mediaUrl} contacto=${found.id}`);
    const sent = await sock.sendMessage(targetJid, payload);
    if (!sent?.key?.id) throw new Error('Baileys no confirmó el ID de envío');
    markServerSent(sent, targetJid, label);
    const messageData = { contact_id: found.id, sender: 'me', text: label };
    if (mediaUrl) Object.assign(messageData, {
      media_path: mediaPath, media_type: mediaType,
      media_name: mediaName || '', media_mime: mimeType || ''
    });
    const { error: messageErr } = await mediaDb.from('messages').insert([messageData]);
    if (messageErr) {
      console.error('[MEDIA ERROR] Enviado por WhatsApp pero NO registrado en CRM:', messageErr.message);
      return res.status(502).json({ error: `WhatsApp recibió el envío pero Supabase no lo guardó: ${messageErr.message}` });
    }
    const { error: contactErr } = await mediaDb.from('contacts').update({
      last_message: label, updated_at: new Date().toISOString()
    }).eq('id', found.id);
    if (contactErr) console.error('[MEDIA ERROR] Contacto:', contactErr.message);
    console.log(`[MEDIA OK] tipo=${mediaType || 'texto'} mensaje guardado contacto=${found.id}`);
    return res.status(200).json({ success: true, messageId: sent.key.id });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}

app.post('/send-message', handleSend);
app.post('/send', handleSend);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
