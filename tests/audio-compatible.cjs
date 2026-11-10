const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { registerAudioCompatible, downloadLimited, inputFormat } = require('../audio-compatible');
const auth = require('../audio-compat-auth.cjs');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dcam-audio-test-'));
  let server;
  try {
    const originalPath = path.join(directory, 'voice.ogg');
    execFileSync(process.env.TEST_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libopus', originalPath]);
    const original = await fs.readFile(originalPath), files = new Map([['customer/voice.ogg', original]]), secret = 'fixture-key-only';
    const messages = { 'message-1': { id: 'message-1', media_path: 'customer/voice.ogg', media_type: 'audio' }, document: { media_path: 'customer/pdf', media_type: 'document' }, broken: { media_path: 'customer/broken', media_type: 'audio' } };
    files.set('customer/broken', Buffer.from('OggS_invalid_audio'));
    let uploads = 0, reads = 0, downloads = 0;
    const bucket = {
      list: async (_, { search }) => ({ data: Array.from(files.keys()).filter(p => p.startsWith('compat-audio/') && p.endsWith('/' + search)).map(p => ({ name: path.basename(p) })) }),
      createSignedUrl: async p => files.has(p) ? { data: { signedUrl: 'https://storage.test/' + p } } : { error: new Error('missing') },
      upload: async (p, bytes, options) => { assert.equal(options.contentType, 'audio/mpeg'); files.set(p, bytes); uploads++; return {}; }
    };
    const db = { from: () => ({ select: () => ({ eq: (_, id) => ({ maybeSingle: async () => { reads++; return { data: messages[id] || null }; } }) }) }), storage: { from: name => { assert.equal(name, 'chat-media'); return bucket; } } };
    const app = express(); app.use(express.json());
    registerAudioCompatible(app, { db, secret, ffmpegPath: process.env.TEST_FFMPEG || '/usr/bin/ffmpeg', fetchImpl: async url => { downloads++; const data = files.get(new URL(url).pathname.slice(1)); return new Response(data, { headers: { 'content-length': data.length } }); } });
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const post = (id, headers = auth.signedHeaders(secret, id)) => fetch(origin + '/audio-compatible', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ messageId: id }) });
    assert.equal((await post('message-1', {})).status, 401); assert.equal(reads, 0);
    assert.equal((await post('message-1', auth.signedHeaders(secret, 'message-1', Date.now() - 1000000))).status, 401);
    const parallel = await Promise.all([post('message-1'), post('message-1')]);
    assert.deepEqual(parallel.map(r => r.status), [200, 200]);
    const result = await parallel[0].json(); assert.equal(result.storagePath, auth.cachePath('customer/voice.ogg'));
    assert.equal(uploads, 1); assert.equal(downloads, 1, 'Same audio is converted once');
    assert.deepEqual(files.get('customer/voice.ogg'), original, 'The original voice note stays intact');
    const mp3Path = path.join(directory, 'voice.mp3'); await fs.writeFile(mp3Path, files.get(result.storagePath));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp3Path], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].codec_name, 'mp3'); assert.equal(probe.streams[0].channels, 1); assert.equal(probe.streams[0].sample_rate, '24000');
    assert(Number(probe.format.duration) >= 1.5 && Number(probe.format.duration) < 1.8, 'No silent truncation');
    assert.equal((await post('message-1')).status, 200); assert.equal(uploads, 1, 'The persisted MP3 cache is reused');
    assert.equal((await post('document')).status, 415); assert.equal((await post('missing')).status, 404); assert.equal((await post('broken')).status, 422);
    assert.equal(files.has(auth.cachePath('customer/broken')), false, 'Conversion failures are not cached');
    assert.throws(() => inputFormat(Buffer.from('#EXTM3U\nfile:///etc/passwd')), /formato/);
    await assert.rejects(downloadLimited('https://storage.test/large', async () => new Response('x', { headers: { 'content-length': 17 * 1024 * 1024 } })), e => e.status === 413);
    assert.equal(auth.verify(secret, 'message-1', auth.signedHeaders('wrong-key', 'message-1')), false);
    assert.equal(auth.verify(secret, 'message-2', auth.signedHeaders(secret, 'message-1')), false);
    console.log('PASS: real OGG/Opus → MP3, duration, mono/24kHz, original preservation, persistent cache, concurrent deduplication, signed access, invalid files and byte limits.');
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
