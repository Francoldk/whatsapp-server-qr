'use strict';
const { createHmac, createHash, timingSafeEqual } = require('crypto');
const DOMAIN = 'dcam-audio-v1';
function signature(secret, id, time) {
  return createHmac('sha256', secret).update(DOMAIN + '\n' + id + '\n' + time).digest('hex');
}
function signedHeaders(secret, id, now = Date.now()) {
  const time = String(Math.floor(now / 1000));
  return { 'x-dcam-audio-time': time, 'x-dcam-audio-signature': signature(secret, id, time) };
}
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id); }
function verify(secret, id, headers, now = Date.now()) {
  if (!secret || !validId(id)) return false;
  const time = headers['x-dcam-audio-time'], mac = headers['x-dcam-audio-signature'];
  if (typeof time !== 'string' || !/^\d{10}$/.test(time) || Math.abs(Math.floor(now / 1000) - Number(time)) > 90 ||
      typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(signature(secret, id, time), 'hex'), Buffer.from(mac, 'hex'));
}
function cachePath(path) { return 'compat-audio/v1/' + createHash('sha256').update(path).digest('hex') + '.mp3'; }
module.exports = { signedHeaders, verify, validId, cachePath };

