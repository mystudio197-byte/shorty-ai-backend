'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const facebook = require('./facebook').createFacebook();

const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = Math.min(Number(process.env.MAX_VIDEO_MB || 100), 500) * 1024 * 1024;
const ALLOWED_HOSTS = new Set((process.env.MP4_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mystudio197-byte.github.io';
const MAX_REDIRECTS = 3;
const buckets = new Map();

function isPublicIP(ip) {
  if (net.isIP(ip) === 4) {
    const a = ip.split('.').map(Number);
    if (a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
        (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
        (a[0] === 169 && a[1] === 254) ||
        (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
        (a[0] === 192 && a[1] === 168) ||
        (a[0] === 192 && a[1] === 0) ||
        (a[0] === 192 && a[1] === 0 && a[2] === 0) ||
        (a[0] === 192 && a[1] === 0 && a[2] === 2) ||
        (a[0] === 198 && (a[1] === 18 || a[1] === 19 || (a[1] === 51 && a[2] === 100))) ||
        (a[0] === 203 && a[1] === 0 && a[2] === 113)) return false;
    return true;
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
        s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') ||
        s.startsWith('ff') || s.startsWith('2001:db8:') || s.startsWith('::ffff:')) return false;
    return true;
  }
  return false;
}
function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'https:' || u.port && u.port !== '443' || u.username || u.password || u.hash ||
      !ALLOWED_HOSTS.has(u.hostname.toLowerCase()) || net.isIP(u.hostname) ||
      !u.pathname.toLowerCase().endsWith('.mp4')) {
    throw new Error('Only HTTPS .mp4 URLs on approved video hosts are supported');
  }
  return u;
}
function publicLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some(a => !isPublicIP(a.address))) return cb(new Error('Blocked non-public network address'));
    const chosen = addresses.find(a => a.family === 4) || addresses[0];
    cb(null, chosen.address, chosen.family);
  });
}
function upstream(url, redirects = 0, validator = validateUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      lookup: publicLookup, timeout: 15000,
      headers: { 'User-Agent': 'ShortyAI-AuthorizedVideoImporter/1.0', 'Accept': 'video/mp4' },
      agent: false
    }, response => {
      const status = response.statusCode || 500;
      if ([301,302,303,307,308].includes(status)) {
        response.resume();
        if (redirects >= MAX_REDIRECTS || !response.headers.location) return reject(new Error('Too many or invalid redirects'));
        try { return resolve(upstream(validator(new URL(response.headers.location, url).href), redirects + 1, validator)); }
        catch(e) { return reject(e); }
      }
      if (status !== 200) { response.resume(); return reject(new Error('Video host returned HTTP ' + status)); }
      const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'video/mp4') { response.resume(); return reject(new Error('Video host must return Content-Type: video/mp4')); }
      const len = Number(response.headers['content-length'] || 0);
      if (len > MAX_BYTES) { response.resume(); return reject(new Error('Video exceeds server size limit')); }
      resolve(response);
    });
    req.on('timeout', () => req.destroy(new Error('Video host timed out')));
    req.on('error', reject);
  });
}
function json(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function rateLimit(ip) {
  const now = Date.now();
  if (buckets.size > 10000) for (const [key,val] of buckets) if (now - val.start > 60000) buckets.delete(key);
  const b = buckets.get(ip) || { start: now, count: 0 };
  if (now - b.start > 60000) { b.start = now; b.count = 0; }
  b.count++; buckets.set(ip, b);
  return b.count <= 12;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const path = new URL(req.url, 'http://localhost');
  if (path.pathname === '/health') return json(res, 200, { ok: true, configuredHosts: ALLOWED_HOSTS.size });
  if (path.pathname.startsWith('/api/facebook/') || path.pathname.startsWith('/auth/facebook')) {
    if (!rateLimit(req.socket.remoteAddress || 'unknown')) return json(res,429,{error:'Too many requests. Try later.'});
    if (await facebook.route(req,res,path,{upstream,maxBytes:MAX_BYTES})) return;
  }
  if (path.pathname !== '/api/download') return json(res, 404, { error: 'Not found' });
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin not allowed' });
  if (!rateLimit(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Too many requests. Try later.' });
  if (req.url.length > 4096) return json(res, 414, { error: 'URL too long' });
  if (path.searchParams.get('authorized') !== 'yes') return json(res, 400, { error: 'Permission confirmation required' });
  let url;
  try { url = validateUrl(path.searchParams.get('url') || ''); }
  catch(e) { return json(res, 400, { error: e.message }); }
  try {
    const video = await upstream(url);
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="shorty-video.mp4"',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    let total = 0;
    video.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BYTES) { video.destroy(); res.destroy(); }
    });
    video.on('error', () => res.destroy());
    res.on('close', () => video.destroy());
    video.pipe(res);
  } catch(e) { if (!res.headersSent) json(res, 422, { error: e.message }); }
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log('Shorty AI backend listening on ' + PORT));
module.exports = { server, validateUrl, isPublicIP };
