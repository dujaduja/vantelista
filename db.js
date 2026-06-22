/* IndexedDB-lager för väntelistan.
   En object store "parties" där varje sällskap sparas med sitt id. */
(function (global) {
  const DB_NAME = 'vantelista';
  const DB_VERSION = 1;
  const STORE = 'parties';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  const DB = {
    async getAll() {
      const store = await tx('readonly');
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async put(party) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        const req = store.put(party);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },

    async putAll(parties) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        let pending = parties.length;
        if (pending === 0) return resolve();
        let failed = false;
        parties.forEach((p) => {
          const req = store.put(p);
          req.onerror = () => {
            if (!failed) { failed = true; reject(req.error); }
          };
          req.onsuccess = () => {
            if (--pending === 0 && !failed) resolve();
          };
        });
      });
    },

    async remove(id) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },

    async removeMany(ids) {
      const store = await tx('readwrite');
      return new Promise((resolve, reject) => {
        let pending = ids.length;
        if (pending === 0) return resolve();
        ids.forEach((id) => {
          const req = store.delete(id);
          req.onsuccess = () => { if (--pending === 0) resolve(); };
          req.onerror = () => reject(req.error);
        });
      });
    },
  };

  global.DB = DB;
})(window);
