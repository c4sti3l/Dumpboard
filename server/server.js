'use strict';
// Dumpboard-Server: statische App + kleine JSON/Datei-API, ohne Abhängigkeiten.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const pipelineP = require('util').promisify(pipeline);

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC = path.join(__dirname, '..', 'public');
const TOKEN = process.env.ACCESS_TOKEN || '';
const AUTH_DISABLED = String(process.env.DISABLE_AUTH || '').toLowerCase() === 'true';

// Sicher als Standard: ohne Passwort startet der Server nur, wenn das ausdrücklich erlaubt wird.
if (!TOKEN && !AUTH_DISABLED) {
  console.error(
    'Kein Passwort gesetzt.\n' +
      '  Mit Passwort:  ACCESS_TOKEN=<langes-passwort> node server/server.js\n' +
      '  Ohne Passwort: DISABLE_AUTH=true node server/server.js  (nur in vertrauenswürdigen Netzen!)'
  );
  process.exit(1);
}
if (TOKEN && AUTH_DISABLED) console.warn('Hinweis: ACCESS_TOKEN ist gesetzt, DISABLE_AUTH wird ignoriert. Das Passwort bleibt aktiv.');
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1048576;

const FILES = path.join(DATA, 'files');
const DB_FILE = path.join(DATA, 'items.json');
fs.mkdirSync(FILES, { recursive: true });

/* ---------- Speicher ---------- */

let items = [];
try {
  items = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {}

const isComplete = (item) => item.files.every((f) => f.done);
const newId = () => crypto.randomBytes(12).toString('hex');
const ID_RE = /^[a-f0-9]{24}$/;

let writing = Promise.resolve();
const save = () =>
  (writing = writing
    .then(() => fs.promises.writeFile(DB_FILE + '.tmp', JSON.stringify(items)))
    .then(() => fs.promises.rename(DB_FILE + '.tmp', DB_FILE))
    .catch((e) => console.error('Speichern fehlgeschlagen', e)));

const unlinkFiles = (item) =>
  item.files.forEach((f) => {
    fs.unlink(path.join(FILES, f.id), () => {});
    fs.unlink(path.join(FILES, f.id + '.part'), () => {});
  });

// Abgebrochene Uploads aus einem früheren Lauf aufräumen.
const stale = items.filter((i) => !isComplete(i));
if (stale.length) {
  stale.forEach(unlinkFiles);
  items = items.filter(isComplete);
  save();
}

const findFile = (id) => {
  for (const item of items) {
    const file = item.files.find((f) => f.id === id);
    if (file) return { item, file };
  }
  return null;
};

/* ---------- Live-Updates (Server-Sent Events) ---------- */

const clients = new Set();
const broadcast = () => clients.forEach((res) => res.write('data: changed\n\n'));
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 25000).unref();

/* ---------- Zugriffsschutz ---------- */

const hash = (s) => crypto.createHash('sha256').update('dumpboard:' + s).digest();
const TOKEN_HASH = hash(TOKEN);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Anmeldung gilt eine Woche ab Login (kein Verlängern) und läuft serverseitig ab: Das Cookie
// enthält das Ablaufdatum, signiert mit einem vom Passwort abgeleiteten Schlüssel.
// Wer das Passwort ändert, meldet damit alle Geräte ab.
const SESSION_MS = 7 * 24 * 3600 * 1000;
const sign = (exp) => crypto.createHmac('sha256', TOKEN_HASH).update(String(exp)).digest();

function authed(req) {
  if (!TOKEN) return true;
  const cookie = /(?:^|;\s*)dumpboard_auth=(\d{1,15})\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (cookie && Number(cookie[1]) > Date.now() && same(Buffer.from(cookie[2], 'hex'), sign(cookie[1]))) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!bearer && same(hash(bearer[1]), TOKEN_HASH);
}

/* ---------- Hilfsfunktionen ---------- */

const fail = (status, message) => Object.assign(new Error(message), { status });

function send(res, code, obj, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size <= limit) chunks.push(d);
    });
    req.on('end', () => {
      if (size > limit) return reject(fail(413, 'Anfrage zu groß'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(fail(400, 'Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const publicItem = ({ files, ...rest }) => ({
  ...rest,
  files: files.map(({ id, name, type, size }) => ({ id, name, type, size })),
});

// Nur harmlose Typen werden inline ausgeliefert; alles andere nur als Download (verhindert gespeichertes HTML/JS).
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/pdf)$/i;

/* ---------- API ---------- */

async function api(req, res, url, p) {
  const method = req.method;

  if (p === '/api/session' && method === 'GET') return send(res, 200, { required: !!TOKEN, auth: authed(req) });

  if (p === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    if (TOKEN && !same(hash(str(body.token, 500)), TOKEN_HASH)) {
      await new Promise((r) => setTimeout(r, 600)); // bremst Durchprobieren
      return send(res, 401, { error: 'Falsches Passwort' });
    }
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    const exp = Date.now() + SESSION_MS;
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `dumpboard_auth=${exp}.${sign(exp).toString('hex')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`,
    });
  }

  if (!authed(req)) return send(res, 401, { error: 'Nicht angemeldet' });

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/items' && method === 'GET') {
    const list = items.filter(isComplete).sort((a, b) => b.createdAt - a.createdAt);
    return send(res, 200, list.map(publicItem));
  }

  if (p === '/api/items' && method === 'POST') {
    const body = await readJson(req);
    const files = (Array.isArray(body.files) ? body.files.slice(0, 50) : []).map((f) => ({
      id: newId(),
      name: path.basename(str(f && f.name, 255)) || 'datei',
      type: /^[\w.+-]+\/[\w.+*-]+$/.test(str(f && f.type, 100)) ? f.type : '',
      size: Number(f && f.size) || 0,
      done: false,
    }));
    const now = Date.now();
    const item = {
      id: newId(),
      // Zeit vom Gerät übernehmen, damit nachträglich hochgeladene Einträge richtig einsortiert werden.
      createdAt: Number.isFinite(body.createdAt) && body.createdAt > 0 && body.createdAt <= now + 60000 ? body.createdAt : now,
      title: str(body.title, 2000),
      text: str(body.text, 200000),
      url: str(body.url, 4000),
      files,
    };
    items.push(item);
    await save();
    if (isComplete(item)) broadcast();
    return send(res, 201, { id: item.id, files: files.map((f) => ({ id: f.id })) });
  }

  if (p === '/api/items' && method === 'DELETE') {
    items.forEach(unlinkFiles);
    items = [];
    await save();
    broadcast();
    return send(res, 200, { ok: true });
  }

  let m = /^\/api\/items\/([a-f0-9]{24})$/.exec(p);
  if (m && method === 'DELETE') {
    const item = items.find((i) => i.id === m[1]);
    if (!item) return send(res, 404, { error: 'Nicht gefunden' });
    unlinkFiles(item);
    items = items.filter((i) => i !== item);
    await save();
    broadcast();
    return send(res, 200, { ok: true });
  }

  m = /^\/api\/files\/([a-f0-9]{24})$/.exec(p);
  if (m && method === 'PUT') return putFile(req, res, m[1]);
  if (m && (method === 'GET' || method === 'HEAD')) return getFile(req, res, m[1], url.searchParams.has('download'));

  if (p === '/api/preview' && method === 'GET') return previewRoute(res, url);
  if (p === '/api/proxy' && method === 'GET') return proxyRoute(res, url);

  send(res, 404, { error: 'Unbekannter Endpunkt' });
}

/* ---------- Link-Vorschau ---------- */

const UA = 'Mozilla/5.0 (compatible; Dumpboard/1.0; +link-preview)';

// Interne Adressen sperren, sonst könnte man den Server auf sein eigenes Netz ansetzen (SSRF).
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::' || l === '::1' || l.startsWith('::ffff:') || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Prüft die tatsächlich aufgelöste Adresse (auch gegen DNS-Rebinding und Weiterleitungen).
const safeLookup = (host, opts, cb) =>
  dns.lookup(host, opts, (err, addr, fam) => {
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
    if (list.some((a) => isPrivateIp(a.address))) return cb(new Error('Adresse gesperrt'));
    cb(null, addr, fam);
  });

function fetchUrl(target, { maxBytes, accept, stopAtHeadEnd = false, redirects = 4 }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error('Ungültige URL'));
    }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Protokoll nicht erlaubt'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('Adresse gesperrt'));

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'GET', lookup: safeLookup, timeout: 8000, headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'de,en;q=0.8' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('Zu viele Weiterleitungen'));
          let next;
          try {
            next = new URL(res.headers.location, u).href;
          } catch {
            return reject(new Error('Ungültige Weiterleitung'));
          }
          return resolve(fetchUrl(next, { maxBytes, accept, stopAtHeadEnd, redirects: redirects - 1 }));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '', finalUrl: u.href });
        };
        res.on('data', (d) => {
          if (done) return;
          chunks.push(d);
          size += d.length;
          if (size >= maxBytes || (stopAtHeadEnd && d.toString('latin1').toLowerCase().includes('</head>'))) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('error', () => (done ? null : reject(new Error('Abgebrochen'))));
        res.on('close', finish);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    req.end();
  });
}

const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] === '#') {
      try {
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      } catch {
        return m;
      }
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e];
  });
const clean = (s, max) => decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max);
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const proxied = (u) => '/api/proxy?u=' + encodeURIComponent(u);
const absolute = (href, base) => {
  try {
    const u = new URL(decodeEntities(href), base);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
};

async function buildPreview(url) {
  const out = { url, host: hostOf(url), siteName: '', title: '', description: '', image: '', favicon: '' };
  try {
    const r = await fetchUrl(url, { maxBytes: 600000, stopAtHeadEnd: true, accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5' });
    const ct = r.contentType.toLowerCase();
    out.host = hostOf(r.finalUrl) || out.host;
    if (ct.startsWith('image/') && !ct.includes('svg')) {
      out.image = proxied(r.finalUrl);
      out.title = decodeURIComponent(new URL(r.finalUrl).pathname.split('/').pop() || '');
    } else if (/html|xml/.test(ct)) {
      const enc = /charset=(iso-8859-\d+|latin1|windows-125\d)/i.test(ct) ? 'latin1' : 'utf8';
      const html = r.buffer.toString(enc);
      const meta = {};
      for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
        const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
        const val = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        if (key && val && !(key[1].toLowerCase() in meta)) meta[key[1].toLowerCase()] = val[1] !== undefined ? val[1] : val[2];
      }
      const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      out.title = clean(meta['og:title'] || meta['twitter:title'] || (titleTag && titleTag[1]), 200);
      out.description = clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300);
      out.siteName = clean(meta['og:site_name'], 80);
      const img = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
      if (img) out.image = absolute(img, r.finalUrl);
      const links = (html.match(/<link\s[^>]*>/gi) || []).map((tag) => ({
        rel: ((/rel\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '').toLowerCase(),
        href: (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1],
      }));
      const icon = links.find((l) => l.rel.includes('apple-touch-icon') && l.href) || links.find((l) => /(^|\s)(shortcut )?icon(\s|$)/.test(l.rel) && l.href && !/\.svg(\?|$)/i.test(l.href));
      if (icon) out.favicon = absolute(icon.href, r.finalUrl);
      if (!out.favicon) out.favicon = new URL('/favicon.ico', r.finalUrl).href;
    }
  } catch (e) {
    out.failed = true;
  }
  if (!out.favicon) {
    try {
      out.favicon = new URL('/favicon.ico', url).href;
    } catch {}
  }
  // Bilder laufen über den Server (kein Hotlinking, keine Tracker-Anfragen vom Gerät, funktioniert hinter Login).
  if (out.image) out.image = out.image.startsWith('/api/proxy') ? out.image : proxied(out.image);
  if (out.favicon) out.favicon = proxied(out.favicon);
  return out;
}

const PREVIEW_FILE = path.join(DATA, 'previews.json');
const PREVIEW_TTL = 7 * 24 * 3600 * 1000;
const PREVIEW_MAX = 2000;
let previewCache = new Map();
try {
  previewCache = new Map(Object.entries(JSON.parse(fs.readFileSync(PREVIEW_FILE, 'utf8'))));
} catch {}
let previewTimer;
const persistPreviews = () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    while (previewCache.size > PREVIEW_MAX) previewCache.delete(previewCache.keys().next().value);
    fs.promises.writeFile(PREVIEW_FILE, JSON.stringify(Object.fromEntries(previewCache))).catch(() => {});
  }, 2000);
};
const inflight = new Map();

function getPreview(url) {
  const hit = previewCache.get(url);
  // Fehlgeschlagene Abrufe nur 10 Minuten merken, erfolgreiche eine Woche.
  if (hit && Date.now() - hit.at < (hit.data.failed ? 600000 : PREVIEW_TTL)) return Promise.resolve(hit.data);
  if (!inflight.has(url)) {
    inflight.set(
      url,
      buildPreview(url)
        .then((data) => {
          previewCache.delete(url);
          previewCache.set(url, { at: Date.now(), data });
          persistPreviews();
          return data;
        })
        .finally(() => inflight.delete(url))
    );
  }
  return inflight.get(url);
}

async function previewRoute(res, url) {
  const target = url.searchParams.get('url') || '';
  if (target.length > 2000 || !/^https?:\/\//i.test(target)) return send(res, 400, { error: 'Ungültige URL' });
  send(res, 200, await getPreview(target), { 'Cache-Control': 'private, max-age=600' });
}

// Erkennt Bildformate am Inhalt statt am Header, SVG wird absichtlich nicht ausgeliefert.
function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (b.toString('latin1', 4, 12).startsWith('ftypavif')) return 'image/avif';
  return null;
}

async function proxyRoute(res, url) {
  const target = url.searchParams.get('u') || '';
  if (target.length > 2000) return send(res, 400, { error: 'Ungültige URL' });
  let r;
  try {
    r = await fetchUrl(target, { maxBytes: 4 * 1048576, accept: 'image/*,*/*;q=0.5' });
  } catch {
    return send(res, 502, { error: 'Nicht abrufbar' });
  }
  const type = sniffImage(r.buffer);
  if (!type) return send(res, 415, { error: 'Kein unterstütztes Bild' });
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': r.buffer.length,
    'Cache-Control': 'private, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  res.end(r.buffer);
}

async function putFile(req, res, id) {
  const found = findFile(id);
  if (!found || found.file.done) return send(res, 404, { error: 'Nicht gefunden' });
  const tmp = path.join(FILES, id + '.part');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > MAX_BYTES ? fail(413, 'Datei zu groß') : null, chunk);
    },
  });
  try {
    await pipelineP(req, counter, fs.createWriteStream(tmp));
  } catch (e) {
    fs.unlink(tmp, () => {});
    throw e;
  }
  await fs.promises.rename(tmp, path.join(FILES, id));
  found.file.done = true;
  found.file.size = bytes;
  await save();
  if (isComplete(found.item)) broadcast();
  send(res, 200, { ok: true });
}

function getFile(req, res, id, asDownload) {
  const found = findFile(id);
  if (!found || !found.file.done) return send(res, 404, { error: 'Nicht gefunden' });
  const { file } = found;
  const full = path.join(FILES, id);
  const size = file.size;
  const inline = !asDownload && INLINE_OK.test(file.type);

  const headers = {
    'Content-Type': inline ? file.type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };

  let start = 0;
  let end = size - 1;
  let code = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2]) && size > 0) {
    if (range[1] === '') start = Math.max(0, size - Number(range[2]));
    else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/* ---------- Statische App ---------- */

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, p) {
  let file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- Server ---------- */

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (p.startsWith('/api/')) return await api(req, res, url, p);
      // Kommt der Share-POST doch beim Server an (Service Worker noch nicht aktiv), nur zur App leiten.
      if (p === '/share-target' && req.method === 'POST') {
        res.writeHead(303, { Location: '/' });
        return res.end();
      }
      serveStatic(req, res, p);
    } catch (e) {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.destroy();
      send(res, e.status || 500, { error: e.status ? e.message : 'Serverfehler' });
    }
  })
  .listen(PORT, () => {
    console.log(`Dumpboard: http://localhost:${PORT}  (Daten: ${DATA}, Passwort: ${TOKEN ? 'ja' : 'NEIN – offen!'})`);
  });
