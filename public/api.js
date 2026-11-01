// Server-API; wird von Seite und Service Worker genutzt.
const API = (() => {
  const call = async (url, opts) => {
    const res = await fetch(url, opts);
    if (res.status === 401) throw Object.assign(new Error('Nicht angemeldet'), { auth: true });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  };
  const json = { 'Content-Type': 'application/json' };

  return {
    session: () => fetch('/api/session', { cache: 'no-store' }).then((r) => r.json()),
    login: (token) => fetch('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ token }) }).then((r) => r.ok),
    list: () => call('/api/items', { cache: 'no-store' }).then((r) => r.json()),
    remove: (id) => call('/api/items/' + id, { method: 'DELETE' }),
    clear: () => call('/api/items', { method: 'DELETE' }),

    // item.files: [{ name, type, size, blob }]. Wirft bei Fehlern (e.auth = nicht angemeldet).
    async create(item) {
      const files = item.files || [];
      const meta = {
        createdAt: item.createdAt,
        title: item.title || '',
        text: item.text || '',
        url: item.url || '',
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      };
      const created = await call('/api/items', { method: 'POST', headers: json, body: JSON.stringify(meta) }).then((r) => r.json());
      try {
        for (let i = 0; i < files.length; i++) {
          await call('/api/files/' + created.files[i].id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: files[i].blob,
          });
        }
      } catch (e) {
        fetch('/api/items/' + created.id, { method: 'DELETE' }).catch(() => {});
        throw e;
      }
      return created.id;
    },
  };
})();
