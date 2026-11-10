'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { verify, cachePath } = require('./audio-compat-auth.cjs');

const MAX_INPUT = 16 * 1024 * 1024, MAX_OUTPUT = 32 * 1024 * 1024;
function failure(status, message) { const error = new Error(message); error.status = status; return error; }
function inputFormat(buffer) {
  if (buffer.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buffer.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buffer.length > 1 && buffer[0] === 255 && (buffer[1] & 224) === 224) return (buffer[1] & 6) ? 'mp3' : 'aac';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'mov';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  if (buffer.toString('ascii', 0, 5) === '#!AMR') return 'amr';
  throw failure(415, 'El archivo no tiene un formato de audio reconocido.');
}
async function downloadLimited(url, fetchImpl) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw failure(502, 'No se pudo descargar el audio original.');
    if (Number(response.headers.get('content-length')) > MAX_INPUT) { controller.abort(); throw failure(413, 'El audio supera 16 MB.'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_INPUT) { controller.abort(); throw failure(413, 'El audio supera 16 MB.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    if (!size) throw failure(415, 'El audio está vacío.');
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error.name === 'AbortError') throw failure(504, 'Se agotó el tiempo al descargar el audio.');
    throw error;
  } finally { clearTimeout(timer); }
}
function runFfmpeg(binary, input, output, format) {
  return new Promise((resolve, reject) => {
    // Files generated in a private temporary directory; never pass a URL or shell command.
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      '-threads', '1', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', output],
    { stdio: ['ignore', 'ignore', 'ignore'] });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 25000);
    child.once('error', () => { clearTimeout(timer); reject(failure(503, 'El conversor de audio no está disponible en Render.')); });
    child.once('close', code => { clearTimeout(timer); if (expired) reject(failure(504, 'El audio tardó demasiado en convertirse.')); else if (code !== 0) reject(failure(422, 'No se pudo convertir este audio.')); else resolve(); });
  });
}
async function convertBuffer(buffer, binary) {
  const format = inputFormat(buffer), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dcam-audio-'));
  try {
    const input = path.join(directory, 'original'), output = path.join(directory, 'compatible.mp3');
    await fs.writeFile(input, buffer);
    await runFfmpeg(binary, input, output, format);
    const stat = await fs.stat(output);
    if (!stat.size || stat.size > MAX_OUTPUT) throw failure(413, 'El MP3 resultante es demasiado grande.');
    return await fs.readFile(output);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function registerAudioCompatible(app, options) {
  const { db, secret } = options, fetchImpl = options.fetchImpl || fetch;
  const jobs = new Map(); let active = 0;
  async function prepare(message) {
    const destination = cachePath(message.media_path), bucket = db.storage.from('chat-media');
    // A list lookup avoids downloading an existing MP3 into the WhatsApp process.
    const name = destination.split('/').pop();
    const cached = await bucket.list('compat-audio/v1', { limit: 1, search: name });
    if (!cached.error && cached.data && cached.data.some(file => file.name === name)) return destination;
    if (jobs.has(destination)) return jobs.get(destination);
    if (active >= 2) throw failure(429, 'Hay otros audios convirtiéndose. Reintentá en unos segundos.');
    const job = (async () => {
      active += 1;
      try {
        const original = await bucket.createSignedUrl(message.media_path, 120);
        if (original.error || !original.data?.signedUrl) throw failure(404, 'El audio original no está disponible.');
        const input = await downloadLimited(original.data.signedUrl, fetchImpl);
        let binary = options.ffmpegPath || process.env.FFMPEG_PATH;
        if (!binary) { try { binary = require('ffmpeg-static'); } catch (_) {} }
        if (!binary) throw failure(503, 'Falta instalar ffmpeg-static en el servidor de WhatsApp.');
        const mp3 = await convertBuffer(input, binary);
        const stored = await bucket.upload(destination, mp3, { contentType: 'audio/mpeg', upsert: true, cacheControl: '3600' });
        if (stored.error) throw failure(502, 'No se pudo guardar el audio compatible.');
        return destination;
      } finally { active -= 1; }
    })();
    jobs.set(destination, job);
    try { return await job; } finally { jobs.delete(destination); }
  }
  app.post('/audio-compatible', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!db || !secret) return res.status(503).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Render.' });
    const id = req.body?.messageId;
    if (!verify(secret, id, req.headers)) return res.status(401).json({ error: 'Solicitud de audio no autorizada.' });
    try {
      const result = await db.from('messages').select('id,media_path,media_type').eq('id', id).maybeSingle();
      if (result.error || !result.data?.media_path) throw failure(404, 'Audio no encontrado.');
      const message = result.data;
      if (message.media_type !== 'audio' && !String(message.media_type).startsWith('audio/')) throw failure(415, 'El mensaje no es un audio.');
      const storagePath = await prepare(message);
      return res.json({ storagePath, mimeType: 'audio/mpeg' });
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.status ? error.message : 'No se pudo preparar el audio compatible.' });
    }
  });
}
module.exports = { registerAudioCompatible, convertBuffer, inputFormat, downloadLimited };
