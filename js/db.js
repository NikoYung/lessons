// Хранилище в IndexedDB. Данные живут только на устройстве.
const DB_NAME = 'lessons';
export const STORES = ['students', 'lessons', 'payments', 'series'];
export const ALL = [...STORES, 'media']; // media — фото и файлы (Blob)
let db;

const req = (r) => new Promise((ok, fail) => {
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
});

const done = (tx) => new Promise((ok, fail) => {
  tx.oncomplete = () => ok();
  tx.onerror = () => fail(tx.error);
  tx.onabort = () => fail(tx.error);
});

export async function openDB() {
  const open = indexedDB.open(DB_NAME, 2);
  open.onupgradeneeded = () => {
    const d = open.result;
    for (const s of ALL) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
  };
  db = await req(open);
  // Просим не удалять данные при нехватке места (Safari иначе может очистить через 7 дней без запуска).
  navigator.storage?.persist?.().catch(() => {});
}

export const getAll = (store) => req(db.transaction(store).objectStore(store).getAll());
export const getMeta = (key) => req(db.transaction('meta').objectStore('meta').get(key));

export async function setMeta(key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}

/** Набор изменений одной транзакцией: [{put:[store, item]} | {del:[store, id]}]. */
export async function apply(ops) {
  const stores = [...new Set(ops.map((o) => (o.put || o.del)[0]))];
  if (!stores.length) return;
  const tx = db.transaction(stores, 'readwrite');
  for (const o of ops) {
    if (o.put) tx.objectStore(o.put[0]).put(o.put[1]);
    else tx.objectStore(o.del[0]).delete(o.del[1]);
  }
  await done(tx);
}

/** Полная замена данных (восстановление копии): при сбое старые данные останутся. */
export async function replaceAll(data) {
  const tx = db.transaction([...ALL, 'meta'], 'readwrite');
  for (const s of ALL) {
    tx.objectStore(s).clear();
    for (const item of data[s] || []) tx.objectStore(s).put(item);
  }
  if (data.settings) tx.objectStore('meta').put(data.settings, 'settings');
  await done(tx);
}
