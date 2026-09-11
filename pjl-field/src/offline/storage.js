import { openDatabaseSync } from 'expo-sqlite';

let database;
function db() {
  if (!database) {
    const next = openDatabaseSync('pjl-field-offline.db');
    next.execSync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS field_store (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
    database = next;
  }
  return database;
}
export function readLocal(key) {
  const row = db().getFirstSync('SELECT value FROM field_store WHERE key = ?', key);
  return row ? JSON.parse(row.value) : null;
}
export function writeLocal(key, value) {
  db().runSync('INSERT INTO field_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
export function storeForOwner(owner) {
  const prefix = `owner:${owner}:`;
  return {
    read: () => readLocal(prefix + 'queue'),
    write: state => writeLocal(prefix + 'queue', state),
    putBlob: (id, payload) => writeLocal(prefix + id, payload),
    getBlob: id => readLocal(prefix + id),
    deleteBlob: id => db().runSync('DELETE FROM field_store WHERE key = ?', prefix + id),
  };
}
