// Gemeinsamer IndexedDB-Zugriff für Service Worker und Seite.
const DB = (() => {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('dumpboard', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', mode);
      let result;
      const req = fn(tx.objectStore('items'));
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
  };

  return {
    add: (item) => run('readwrite', (s) => s.add(item)),
    all: () => run('readonly', (s) => s.getAll()),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();
