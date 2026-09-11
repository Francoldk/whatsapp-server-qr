const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || 'https://crm-dcam-produccion.vercel.app/api/whatsapp-webhook';
const AI_EXTRACT_URL = process.env.AI_EXTRACT_URL || 'https://crm-dcam-produccion.vercel.app/api/ai-extract';

let sock = null;
let currentQR = '';

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
  console.log('🚀 Inicializando Baileys con auth local...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

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
        console.log('📲 QR recibido de Baileys, convirtiendo a DataURL...');
        currentQR = await QRCode.toDataURL(qr);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        console.log(`❌ Conexión cerrada. Código: ${statusCode}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(connectToWhatsApp, 3000);
        } else {
          console.log('⚠️ Sesión cerrada por WhatsApp. Reiniciando credenciales...');
          currentQR = '';
          setTimeout(connectToWhatsApp, 2000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp CONECTADO exitosamente al número oficial');
        currentQR = 'CONNECTED';
      }
    });

    // Escuchar mensajes y despachar a Vercel
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const rawJid = msg.key.remoteJid || '';
          if (rawJid.includes('@g.us') || rawJid.includes('@broadcast') || rawJid === 'status@broadcast') continue;

          const text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       (msg.message.imageMessage ? '📷 Imagen recibida' : '') ||
                       (msg.message.documentMessage ? `📄 Documento PDF: ${msg.message.documentMessage.fileName || 'archivo.pdf'}` : '');
          
          if (!text) continue;

          const cleanPhone = rawJid.replace(/\D/g, '');
          const name = msg.pushName || `+${cleanPhone}`;
          console.log(`📩 Mensaje entrante de ${name} (${cleanPhone}): ${text}`);

          try {
            // Notificar al CRM en Vercel
            const resCrm = await fetch(CRM_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone: cleanPhone, name, text, sender: 'client' })
            });

            const crmData = await resCrm.json();
            const conv = crmData?.conversation;

            if (conv && conv.botActive === false) {
              console.log(`⏸️ Sol en pausa manual para ${name}`);
              continue;
            }

            // Sol AI
            const history = conv?.messages?.length ? conv.messages : [{ sender: 'client', text }];
            const aiData = await askSolAI(history);

            if (aiData?.replyMessage) {
              await sock.sendMessage(rawJid, { text: aiData.replyMessage });

              // Guardar la respuesta de Sol y la ficha autocompletada en Vercel
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
          } catch (e) {
            console.error('Error puenteando al CRM:', e.message);
          }
        }
      }
    });

  } catch (err) {
    console.error('Fallo iniciando Baileys:', err.message);
    setTimeout(connectToWhatsApp, 5000);
  }
}

connectToWhatsApp();

app.get('/', (req, res) => {
  res.send('<h2>✅ Servidor WhatsApp DCAM Online</h2>');
});

app.get('/qr', (req, res) => {
  if (currentQR === 'CONNECTED') {
    return res.send(`
      <div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
        <h2 style="color:#059669;">✅ WhatsApp ya está conectado</h2>
        <p>El bot y el CRM están listos para recibir mensajes.</p>
      </div>
    `);
  }
  if (!currentQR) {
    return res.send(`
      <div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
        <h2>Iniciando WhatsApp...</h2>
        <p>Esta página se recarga sola en 3 segundos.</p>
        <script>setTimeout(() => location.reload(), 3000);</script>
      </div>
    `);
  }
  res.send(`
    <div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
      <h2>Escaneá con el WhatsApp Oficial de DCAM</h2>
      <img src="${currentQR}" style="width:320px;height:320px;border: 1px solid #ccc; border-radius: 8px;"/>
      <p style="color:#666;font-size:13px;margin-top:10px;">Si tarda en leer, recargá para obtener un QR fresco.</p>
    </div>
  `);
});

// Endpoint unificado para envíos manuales desde el CRM
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
    console.error('Error enviando mensaje:', error);
    res.status(500).json({ error: error.message });
  }
}

app.post('/send-message', handleSend);
app.post('/send', handleSend);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));