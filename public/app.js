const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const emptyEl = $('#empty');
const qEl = $('#q');

const URL_RE = /https?:\/\/[^\s<>"'\])}]+/gi;
const TRAIL_RE = /[.,;:!?]+$/;

const ICONS = {
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  text: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>',
  share: '<path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

let items = [];
let filter = 'all';
let epoch = 0; // zählt bei jedem Sperren hoch; verspätete Antworten aus der Zeit davor werden verworfen
let objectUrls = [];

/* ---------- Link-Vorschau (vom Server geholt und gecacht) ---------- */

const previewData = new Map();
const previewReq = new Map();
const previewFail = new Map();

function getPreview(url) {
  if (previewData.has(url)) return Promise.resolve(previewData.get(url));
  if (Date.now() - (previewFail.get(url) || 0) < 60000) return Promise.resolve(null);
  if (!previewReq.has(url)) {
    const gen = epoch;
    previewReq.set(
      url,
      fetch('/api/preview?url=' + encodeURIComponent(url))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((d) => {
          previewReq.delete(url);
          if (gen !== epoch) return null;
          if (d) previewData.set(url, d);
          else previewFail.set(url, Date.now());
          return d;
        })
    );
  }
  return previewReq.get(url);
}

const hasPreview = (d) => d && (d.title || d.description || d.image);

// Dateityp-Farben für die Icons
const KINDS = [
  [/^pdf$/, '#f87171'],
  [/^(docx?|odt|rtf|txt|md|pages)$/, '#60a5fa'],
  [/^(xlsx?|csv|ods|numbers)$/, '#4ade80'],
  [/^(pptx?|odp|key)$/, '#fb923c'],
  [/^(zip|rar|7z|tar|gz|tgz|bz2)$/, '#fbbf24'],
  [/^(mp3|wav|flac|m4a|ogg|opus|aac)$/, '#c084fc'],
  [/^(mp4|mov|mkv|webm|avi|m4v)$/, '#f472b6'],
  [/^(js|ts|json|py|html|css|sh|yml|yaml|xml|sql|php|java|c|cpp|go|rs)$/, '#94a3b8'],
  [/^(apk|exe|msi|dmg|deb)$/, '#2dd4bf'],
];
const kindColor = (name) => {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [])[1];
  const hit = ext && KINDS.find(([re]) => re.test(ext.toLowerCase()));
  return hit ? hit[1] : null;
};

/* ---------- Analyse eines Eintrags ---------- */

function extractLinks(...parts) {
  const found = [];
  for (const part of parts) {
    for (const m of (part || '').matchAll(URL_RE)) {
      const url = m[0].replace(TRAIL_RE, '');
      if (!found.includes(url)) found.push(url);
    }
  }
  return found;
}

function analyse(item) {
  // Android legt die geteilte URL oft in "text" (selten in "title") statt in "url".
  const links = [];
  const explicit = (item.url || '').trim();
  if (/^https?:\/\//i.test(explicit)) links.push(explicit);
  for (const l of extractLinks(item.url, item.text, item.title)) if (!links.includes(l)) links.push(l);

  const leftover = (item.text || '').replace(URL_RE, '').trim();
  const files = item.files || [];
  const images = files.filter((f) => f.type.startsWith('image/'));
  const others = files.filter((f) => !f.type.startsWith('image/'));

  const types = new Set();
  if (links.length) types.add('link');
  if (leftover || (item.title && !links.length && !files.length)) types.add('text');
  if (images.length) types.add('image');
  if (others.length) types.add('file');
  if (!types.size) types.add('text');

  // Titel und Beschreibung der verlinkten Seiten sind mit durchsuchbar, sobald die Vorschau geladen ist.
  const previewText = links.map((l) => previewData.get(l)).filter(Boolean).map((d) => `${d.title} ${d.description} ${d.siteName}`);
  const searchable = [item.title, item.text, item.url, ...links, ...previewText, ...files.map((f) => f.name + ' ' + f.type)]
    .join(' ')
    .toLowerCase();

  return { links, images, others, types, searchable, primary: ['image', 'link', 'file', 'text'].find((t) => types.has(t)) };
}

/* ---------- Hilfsfunktionen ---------- */

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

function terms() {
  return qEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Text mit anklickbaren Links und Markierung der Suchtreffer.
function richText(str) {
  const frag = document.createDocumentFragment();
  const t = terms();
  const mark = (s, parent) => {
    if (!t.length) return parent.append(s);
    const re = new RegExp('(' + t.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    s.split(re).forEach((piece, i) => {
      if (i % 2) {
        const m = el('mark');
        m.textContent = piece;
        parent.append(m);
      } else parent.append(piece);
    });
  };
  let last = 0;
  for (const m of str.matchAll(URL_RE)) {
    const url = m[0].replace(TRAIL_RE, '');
    mark(str.slice(last, m.index), frag);
    const a = el('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    mark(url, a);
    frag.append(a);
    last = m.index + url.length;
  }
  mark(str.slice(last), frag);
  return frag;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
}

function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const day = new Date(d).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Heute, ' + time;
  if (day === today - 864e5) return 'Gestern, ' + time;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + time;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : 'FILE';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function download(file) {
  const url = URL.createObjectURL(file.blob);
  const a = el('a');
  a.href = url;
  a.download = file.name || 'datei';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Verwandelt die einfache Link-Karte in eine Karte mit Bild, Favicon, Titel und Beschreibung.
function fillLinkCard(l, url, d) {
  if (!hasPreview(d)) return;
  l.classList.add('rich');
  l.replaceChildren();
  if (d.image) {
    const img = el('img', 'lc-img');
    img.src = d.image;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    l.append(img);
  }
  const body = el('div', 'lc-body');
  const site = el('div', 'lc-site');
  if (d.favicon) {
    const fav = el('img', 'lc-fav');
    fav.src = d.favicon;
    fav.alt = '';
    fav.addEventListener('error', () => fav.replaceWith(el('span', 'lc-fav-ico', icon('link'))));
    site.append(fav);
  } else site.append(el('span', 'lc-fav-ico', icon('link')));
  const name = el('span');
  name.textContent = d.siteName || d.host;
  site.append(name);
  body.append(site);
  if (d.title) {
    const t = el('b', 'lc-title');
    t.textContent = d.title;
    body.append(t);
  }
  if (d.description) {
    const p = el('p', 'lc-desc');
    p.textContent = d.description;
    body.append(p);
  }
  const u = el('small', 'lc-url');
  u.textContent = url;
  body.append(u);
  l.append(body);
}

// Einträge vom Server haben f.id, noch nicht hochgeladene (Warteschlange) f.blob.
function fileUrl(f) {
  if (!f.blob) return '/api/files/' + f.id;
  const u = URL.createObjectURL(f.blob);
  objectUrls.push(u);
  return u;
}

function downloadFile(f) {
  if (f.blob) return download(f);
  const a = el('a');
  a.href = `/api/files/${f.id}?download=1`;
  a.download = f.name || 'datei';
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- Rendering ---------- */

function card(item) {
  const a = item._a;
  const li = el('li', 'card t-' + a.primary);

  const head = el('div', 'card-head');
  const badges = el('div', 'badges');
  const labels = { link: 'Link', text: 'Text', image: 'Bild', file: 'Datei' };
  for (const t of a.types) badges.append(el('span', 'badge b-' + t, icon(t) + labels[t]));
  if (item._pending) badges.append(el('span', 'badge b-pending', 'Wartet auf Upload'));
  head.append(badges, el('time', 'muted', ''));
  head.lastChild.textContent = fmtTime(item.createdAt);
  li.append(head);

  if (item.title && item.title.trim() !== (item.text || '').trim()) {
    const h = el('h3');
    h.append(richText(item.title));
    li.append(h);
  }

  const bodyText = (item.text || '').trim();
  if (bodyText) {
    const p = el('p', 'body');
    p.append(richText(bodyText));
    li.append(p);
  }

  for (const url of a.links) {
    const l = el('a', 'linkcard');
    l.href = url;
    l.target = '_blank';
    l.rel = 'noopener noreferrer';
    l.innerHTML = `<span class="lc-ico">${icon('link')}</span><span class="lc-txt"><b></b><small></small></span>`;
    l.querySelector('b').textContent = host(url);
    l.querySelector('small').textContent = url;
    li.append(l);
    if (previewData.has(url)) fillLinkCard(l, url, previewData.get(url));
    else if (!item._pending && !offline) {
      l.classList.add('loading');
      getPreview(url).then((d) => {
        l.classList.remove('loading');
        fillLinkCard(l, url, d);
      });
    }
  }

  if (a.images.length) {
    const grid = el('div', 'thumbs n' + Math.min(a.images.length, 3));
    for (const f of a.images) {
      const u = fileUrl(f);
      const img = el('img');
      img.src = u;
      img.alt = f.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => {
        $('#lightbox img').src = u;
        $('#lightbox').showModal();
      });
      grid.append(img);
    }
    li.append(grid);
  }

  // Video und Audio direkt abspielbar (der Server unterstützt Range-Anfragen zum Spulen).
  for (const f of a.others) {
    const tag = /^video\/(mp4|webm|ogg)$/i.test(f.type) ? 'video' : /^audio\//i.test(f.type) ? 'audio' : null;
    if (!tag) continue;
    const player = el(tag, 'player');
    player.controls = true;
    player.preload = 'metadata';
    player.src = fileUrl(f);
    li.append(player);
  }

  for (const f of [...a.images, ...a.others]) {
    const row = el('div', 'file');
    row.innerHTML = `<span class="ext"></span><span class="f-txt"><b></b><small></small></span>`;
    const ext = row.querySelector('.ext');
    ext.textContent = extOf(f.name);
    const color = kindColor(f.name);
    if (color) ext.style.setProperty('--c', color);
    row.querySelector('b').textContent = f.name || 'Unbenannt';
    row.querySelector('small').textContent = `${fmtSize(f.size)} · ${f.type || 'unbekannt'}`;
    if (!f.blob && f.type === 'application/pdf') {
      const open = el('a', 'btn small', icon('link') + 'Öffnen');
      open.href = '/api/files/' + f.id;
      open.target = '_blank';
      open.rel = 'noopener';
      row.append(open);
    }
    const dl = el('button', 'btn small', icon('download') + 'Download');
    dl.addEventListener('click', () => downloadFile(f));
    row.append(dl);
    li.append(row);
  }

  const actions = el('div', 'actions');
  const canShare = !!navigator.share;
  if (canShare) {
    const s = el('button', 'btn ghost', icon('share') + 'Teilen');
    s.addEventListener('click', () => shareItem(item));
    actions.append(s);
  }
  const textForCopy = [item.title, item.text, ...a.links.filter((l) => !(item.text || '').includes(l))].filter(Boolean).join('\n');
  if (textForCopy) {
    const c = el('button', 'btn ghost', icon('copy') + 'Kopieren');
    c.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textForCopy);
        toast('In die Zwischenablage kopiert');
      } catch {
        toast('Kopieren nicht möglich');
      }
    });
    actions.append(c);
  }
  const del = el('button', 'btn ghost danger', icon('trash') + 'Löschen');
  del.addEventListener('click', () =>
    confirmDialog('Eintrag löschen?', 'Dieser Eintrag wird auf allen Geräten endgültig entfernt.', 'Löschen', async () => {
      try {
        if (item._pending) await DB.remove(item._dbId);
        else await API.remove(item.id);
      } catch (e) {
        return e.auth ? showLogin() : toast('Löschen fehlgeschlagen');
      }
      li.classList.add('leaving');
      setTimeout(load, 180);
    })
  );
  actions.append(del);
  li.append(actions);
  return li;
}

async function shareItem(item) {
  const data = { title: item.title || undefined, text: item.text || undefined };
  const links = item._a.links;
  if (links.length === 1 && !(item.text || '').includes(links[0])) data.url = links[0];
  try {
    const files = await Promise.all(
      (item.files || []).map(async (f) => new File([f.blob || (await (await fetch('/api/files/' + f.id)).blob())], f.name, { type: f.type }))
    );
    if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
    await navigator.share(data);
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen nicht möglich');
  }
}

function render() {
  if (!unlocked) return renderSkeleton(); // nie Inhalte zeigen, solange der Server die Anmeldung nicht bestätigt hat
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  listEl.replaceChildren();

  const t = terms();
  const shown = items.filter(
    (it) => (filter === 'all' || it._a.types.has(filter)) && t.every((w) => it._a.searchable.includes(w))
  );
  shown.forEach((it) => listEl.append(card(it)));

  $('#count').textContent = t.length || filter !== 'all'
    ? `${shown.length} von ${items.length} Einträgen`
    : `${items.length} ${items.length === 1 ? 'Eintrag' : 'Einträge'}`;
  if (offline) $('#count').textContent += ' · offline';
  $('#clearAll').hidden = !items.length;
  $('#qClear').hidden = !qEl.value;

  emptyEl.hidden = shown.length > 0;
  if (!shown.length) {
    emptyEl.innerHTML = items.length
      ? `<div class="empty-ico">${icon('text')}</div><h2>Nichts gefunden</h2><p class="muted">Passe Suche oder Filter an.</p>`
      : `<div class="empty-ico">${icon('share')}</div><h2>Noch nichts empfangen</h2>
         <p class="muted">Öffne in einer anderen App das Teilen-Menü und wähle <b>Dumpboard</b>. Links, Text, Bilder und Dateien landen hier und sind auf allen deinen Geräten sichtbar.</p>`;
  }
}

let offline = false;
let unlocked = false; // true erst, wenn der Server die Liste ausgeliefert hat
let authRequired = null; // null = noch unbekannt
let remoteItems = []; // nur im Speicher, überbrückt kurze Offline-Phasen innerhalb derselben Sitzung

// Platzhalter vor der Anmeldung: sieht immer gleich aus und verrät nichts über die Inhalte.
function renderSkeleton() {
  listEl.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const li = el(
      'li',
      'card skeleton',
      '<div class="sk sk-chip"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div>' + (i % 2 ? '<div class="sk sk-block"></div>' : '')
    );
    li.setAttribute('aria-hidden', 'true');
    listEl.append(li);
  }
  emptyEl.hidden = true;
  $('#count').textContent = 'Gesperrt';
  $('#clearAll').hidden = true;
  $('#qClear').hidden = true;
}

// Entfernt alle Inhalte aus Seite und Speicher. Nur die Warteschlange noch nicht hochgeladener Einträge
// bleibt in IndexedDB, sie wird erst nach der Anmeldung wieder angezeigt.
function wipe() {
  epoch++;
  unlocked = false;
  items = [];
  remoteItems = [];
  previewData.clear();
  previewReq.clear();
  previewFail.clear();
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  staged = [];
  renderStaged();
  msgEl.value = '';
  autogrow();
  closePreview();
  dismissed.clear();
  qEl.value = '';
  for (const id of ['#lightbox', '#confirm']) if ($(id).open) $(id).close();
  $('#lightbox img').removeAttribute('src');
  if (events) {
    events.close();
    events = null;
  }
  $('#lock').hidden = true;
  document.body.classList.add('locked');
  renderSkeleton();
}

async function lock() {
  let ok = false;
  try {
    ok = (await fetch('/api/logout', { method: 'POST' })).ok;
  } catch {}
  wipe();
  showLogin();
  if (!ok) toast('Offline: Die Sitzung am Server bleibt aktiv');
}

async function load() {
  const gen = epoch;
  let remote;
  try {
    remote = await API.list();
    offline = false;
  } catch (e) {
    if (gen !== epoch) return;
    if (e.auth) {
      wipe();
      showLogin();
      return;
    }
    offline = true;
    if (!unlocked) {
      // Frischer Start ohne Server: lokal wird absichtlich nichts zwischengespeichert, also gibt es nichts zu zeigen.
      renderSkeleton();
      $('#count').textContent = 'Server nicht erreichbar';
      return;
    }
    remote = remoteItems;
  }
  if (gen !== epoch) return;
  remoteItems = remote;
  if (authRequired === null) {
    try {
      authRequired = (await API.session()).required;
    } catch {}
  }
  const pending = (await DB.all()).map((it) => ({ ...it, id: 'p' + it.id, _dbId: it.id, _pending: true }));
  if (gen !== epoch) return;
  unlocked = true;
  document.body.classList.remove('locked');
  $('#lock').hidden = !authRequired;
  items = [...remote, ...pending].sort((a, b) => b.createdAt - a.createdAt);
  items.forEach((it) => (it._a = analyse(it)));
  render();
  connectEvents();
  prefetchPreviews();
}

// Holt die Vorschauen aller Links im Hintergrund, damit die Suche auch Seitentitel und Beschreibungen findet.
let prefetching = false;
async function prefetchPreviews() {
  if (prefetching || offline) return;
  prefetching = true;
  try {
    const urls = [...new Set(items.slice(0, 80).flatMap((it) => it._a.links))].filter((u) => !previewData.has(u));
    let next = 0;
    let got = 0;
    const worker = async () => {
      while (next < urls.length) if (await getPreview(urls[next++])) got++;
    };
    await Promise.all([worker(), worker(), worker()]);
    if (got) {
      items.forEach((it) => (it._a = analyse(it)));
      if (terms().length) render();
    }
  } finally {
    prefetching = false;
  }
}

// Warteschlange (offline oder nicht angemeldet geteilt) zum Server hochladen.
let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    let sent = 0;
    for (const it of await DB.all()) {
      try {
        await API.create(it);
        await DB.remove(it.id);
        sent++;
      } catch (e) {
        if (e.auth) showLogin();
        break;
      }
    }
    if (sent) {
      toast(`${sent} wartende${sent === 1 ? 'r Eintrag' : ' Einträge'} hochgeladen ✓`);
      await load();
    }
  } finally {
    flushing = false;
  }
}

/* ---------- Anmeldung & Live-Updates ---------- */

function showLogin() {
  document.body.classList.add('locked');
  const d = $('#login');
  if (!d.open) d.showModal();
}
// Der Anmeldedialog lässt sich nicht mit Esc wegdrücken.
$('#login').addEventListener('cancel', (e) => e.preventDefault());

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#loginPw');
  $('#loginErr').hidden = true;
  let ok = false;
  try {
    ok = await API.login(input.value);
  } catch {}
  if (!ok) {
    $('#loginErr').hidden = false;
    input.select();
    return;
  }
  input.value = '';
  $('#login').close();
  authRequired = true;
  epoch++; // Anfragen, die vor dem Login gestartet wurden und mit 401 zurückkommen, dürfen nicht erneut sperren
  await load();
  flushOutbox();
});

let events;
function connectEvents() {
  if (events || !unlocked || !('EventSource' in window)) return;
  events = new EventSource('/api/events');
  events.onmessage = load;
  events.onerror = () => {
    // Bei 401 gibt der Browser auf; nach erneutem Login verbinden wir neu (load() ruft das auf).
    if (events && events.readyState === EventSource.CLOSED) {
      events = null;
      if (unlocked) setTimeout(connectEvents, 5000);
    }
  };
}

/* ---------- Events ---------- */

qEl.addEventListener('input', render);
$('#qClear').addEventListener('click', () => {
  qEl.value = '';
  render();
  qEl.focus();
});
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
  render();
});
let onConfirm = null;
function confirmDialog(title, text, okLabel, action) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  onConfirm = action;
  $('#confirm').showModal();
}
// Der Button schließt den Dialog selbst (form method="dialog"); die Aktion läuft nur bei "Löschen".
$('#confirmOk').addEventListener('click', () => {
  const action = onConfirm;
  onConfirm = null;
  if (action) action();
});
$('#clearAll').addEventListener('click', () =>
  confirmDialog('Alles löschen?', `Alle ${items.length} Einträge werden auf allen Geräten endgültig entfernt.`, 'Alle löschen', async () => {
    try {
      await API.clear();
      await DB.clear();
    } catch (e) {
      return e.auth ? showLogin() : toast('Löschen fehlgeschlagen');
    }
    toast('Alle Einträge gelöscht');
    load();
  })
);
$('#lock').addEventListener('click', lock);
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.tagName !== 'IMG') e.currentTarget.close();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  load().then(flushOutbox);
});
if ('BroadcastChannel' in window) new BroadcastChannel('dumpboard').onmessage = load;

/* ---------- Eingabeleiste: Text, Einfügen, Drag & Drop, Dateiauswahl ---------- */

const msgEl = $('#msg');
const stagedEl = $('#staged');
let staged = [];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stage(files) {
  for (const f of files) {
    // Eingefügte Screenshots heißen meist nur "image.png".
    const generic = /^image\.\w+$/i.test(f.name) || !f.name;
    const ext = (f.type.split('/')[1] || 'bin').split('+')[0];
    const file = generic ? new File([f], `Einfügen-${stamp()}-${staged.length}.${ext}`, { type: f.type }) : f;
    staged.push(file);
  }
  renderStaged();
}

function renderStaged() {
  stagedEl.replaceChildren();
  stagedEl.hidden = !staged.length;
  staged.forEach((f, i) => {
    const s = el('div', 'stage');
    if (f.type.startsWith('image/')) {
      const img = el('img');
      img.src = URL.createObjectURL(f);
      img.onload = () => URL.revokeObjectURL(img.src);
      s.append(img);
    } else {
      const e = el('span', 'ext');
      e.textContent = extOf(f.name);
      s.append(e);
    }
    const n = el('span', 'n', '<b></b><small></small>');
    n.querySelector('b').textContent = f.name;
    n.querySelector('b').style.cssText = 'overflow:hidden;text-overflow:ellipsis;font-weight:600';
    n.querySelector('small').textContent = fmtSize(f.size);
    const x = el('button', null, '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Entfernen');
    x.addEventListener('click', () => {
      staged.splice(i, 1);
      renderStaged();
    });
    s.append(n, x);
    stagedEl.append(s);
  });
  updateSend();
}

function updateSend() {
  $('#send').disabled = !msgEl.value.trim() && !staged.length;
}

function autogrow() {
  msgEl.style.height = 'auto';
  const border = msgEl.offsetHeight - msgEl.clientHeight;
  const full = msgEl.scrollHeight + border;
  msgEl.style.height = Math.min(full, 160) + 'px';
  msgEl.style.overflowY = full > 160 ? 'auto' : 'hidden';
  updateSend();
}

async function submitComposer() {
  const text = msgEl.value.trim();
  if (!text && !staged.length) return;
  const files = staged.map((f) => ({ name: f.name, type: f.type, size: f.size, blob: f }));
  const item = { createdAt: Date.now(), title: '', text, url: '', files };
  $('#send').disabled = true;
  let message = 'Gespeichert ✓';
  try {
    await API.create(item);
  } catch (e) {
    await DB.add(item);
    if (e.auth) showLogin();
    message = e.auth ? 'Bitte anmelden – Eintrag wartet' : 'Offline – wird später hochgeladen';
  }
  msgEl.value = '';
  staged = [];
  dismissed.clear();
  closePreview();
  renderStaged();
  autogrow();
  await load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(message);
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  submitComposer();
});
/* Link-Vorschau schon beim Einfügen, ohne Enter */

const prevEl = $('#linkPrev');
const dismissed = new Set();
let prevUrl = null;
let prevTimer;
let fastPreview = false;

function firstUrl(text) {
  const m = text.match(URL_RE);
  const url = m && m[0].replace(TRAIL_RE, '');
  return url && /^https?:\/\/[^/\s]+\.[^/\s]{2,}/i.test(url) ? url : null;
}

function schedulePreview(delay) {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(updatePreview, delay);
}

function closePreview() {
  prevUrl = null;
  prevEl.hidden = true;
  prevEl.replaceChildren();
}

function previewBox(url, d) {
  const box = el('div', 'lp' + (d ? '' : ' loading'));
  if (d && d.image) {
    const img = el('img', 'lp-img');
    img.src = d.image;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  const txt = el('div', 'lp-txt');
  const site = el('small', 'lp-site');
  site.textContent = (d && (d.siteName || d.host)) || host(url);
  const title = el('b');
  title.textContent = (d && d.title) || url;
  txt.append(site, title);
  if (d && d.description) {
    const desc = el('span', 'lp-desc');
    desc.textContent = d.description;
    txt.append(desc);
  }
  const x = el('button', 'lp-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Vorschau entfernen');
  x.addEventListener('click', () => {
    dismissed.add(url);
    closePreview();
  });
  box.append(txt, x);
  return box;
}

async function updatePreview() {
  const url = firstUrl(msgEl.value);
  if (!url || dismissed.has(url)) return closePreview();
  if (url === prevUrl) return;
  prevUrl = url;
  prevEl.hidden = false;
  prevEl.replaceChildren(previewBox(url, previewData.get(url) || null));
  const d = await getPreview(url);
  if (prevUrl === url) prevEl.replaceChildren(previewBox(url, d));
}

msgEl.addEventListener('paste', () => (fastPreview = true));
msgEl.addEventListener('input', () => {
  autogrow();
  schedulePreview(fastPreview ? 0 : 600);
  fastPreview = false;
});
msgEl.addEventListener('keydown', (e) => {
  // Am PC sendet Enter, Shift+Enter macht einen Zeilenumbruch; am Handy bleibt Enter ein Umbruch.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    submitComposer();
  }
});
$('#attach').addEventListener('click', () => $('#filePick').click());
$('#filePick').addEventListener('change', (e) => {
  stage([...e.target.files]);
  e.target.value = '';
  msgEl.focus();
});

// Strg+V: Bilder/Dateien aus der Zwischenablage landen in der Eingabeleiste.
document.addEventListener('paste', (e) => {
  // In anderen Eingabefeldern (Suche, Passwort) und Dialogen normal einfügen lassen.
  if (e.target !== msgEl && e.target.closest('input, textarea, dialog, [contenteditable]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    stage(files);
    msgEl.focus();
  } else if (e.target !== msgEl) {
    const text = e.clipboardData?.getData('text');
    if (text) {
      e.preventDefault();
      msgEl.value += text;
      autogrow();
      schedulePreview(0);
      msgEl.focus();
    }
  }
});

// Drag & Drop auf das ganze Fenster.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropzone').hidden = false;
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0;
    $('#dropzone').hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  stage([...e.dataTransfer.files]);
  msgEl.focus();
});

autogrow();

/* ---------- Start ---------- */

const SHARE_MESSAGES = {
  1: 'Gespeichert ✓',
  queued: 'Offline gespeichert – Upload folgt',
  login: 'Bitte anmelden – Eintrag wartet',
  error: 'Speichern fehlgeschlagen',
};
const params = new URLSearchParams(location.search);
if (params.has('shared')) {
  toast(SHARE_MESSAGES[params.get('shared')] || SHARE_MESSAGES.error);
  history.replaceState(null, '', '/');
}
// Bis der Server die Anmeldung bestätigt hat, gibt es nur Platzhalter. Alte Listen-Zwischenspeicher früherer Versionen löschen.
try {
  localStorage.removeItem('dumpboard:list');
} catch {}
document.body.classList.add('locked');
renderSkeleton();
load().then(flushOutbox);
window.addEventListener('online', () => {
  load();
  flushOutbox();
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
}
