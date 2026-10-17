// Makes a consistent copy of the database while the server keeps running.
// Usage: npm run backup [-- <folder>]   (default folder: <DATA_DIR>/backups)
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const source = path.join(dataDir, 'assets.db');
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}`);
  process.exit(1);
}
const folder = path.resolve(process.argv[2] || path.join(dataDir, 'backups'));
fs.mkdirSync(folder, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const target = path.join(folder, `assets-${stamp}.db`);

const db = new DatabaseSync(source, { readOnly: true });
await backup(db, target);
db.close();
console.log(`Backed up to ${target}`);
