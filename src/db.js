import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = {
  in_stock: 'In stock',
  in_use: 'In use',
  repair: 'In repair',
  lost: 'Missing',
  retired: 'Retired',
  disposed: 'Disposed',
};

// A category's kind decides which device-specific fields the form shows.
export const KINDS = {
  computer: 'Computer',
  mobile: 'Mobile device',
  network: 'Network device',
  display: 'Display',
  other: 'Other',
};

// Every editable asset column. The client builds its form from this list and
// the CSV import/export uses the labels as column headers.
export const FIELDS = [
  { key: 'tag', label: 'Asset tag', section: 'identity', max: 64 },
  { key: 'category_id', label: 'Category', section: 'identity', type: 'category' },
  { key: 'name', label: 'Hostname', section: 'hardware', mono: true },
  // Status is changed with the quick actions (check out, repair…), not the form.
  { key: 'status', label: 'Status', section: 'identity', type: 'status', form: false },
  { key: 'assignee', label: 'User', section: 'assignment' },
  { key: 'location', label: 'Location', section: 'assignment' },
  { key: 'manufacturer', label: 'Manufacturer', section: 'hardware' },
  { key: 'model', label: 'Model', section: 'hardware' },
  { key: 'serial', label: 'Serial number', section: 'hardware', scan: true, mono: true },
  { key: 'implementation_date', label: 'Implementation date', section: 'hardware', type: 'date' },
  { key: 'os', label: 'Operating system', section: 'hardware', kinds: ['computer', 'mobile'] },
  { key: 'firmware', label: 'Firmware version', section: 'hardware', kinds: ['network'] },
  { key: 'imei', label: 'IMEI', section: 'hardware', kinds: ['mobile'], scan: true, mono: true },
  { key: 'phone_number', label: 'Phone number', section: 'hardware', kinds: ['mobile'] },
  { key: 'carrier', label: 'Carrier', section: 'hardware', kinds: ['mobile'] },
  { key: 'screen_size', label: 'Screen size', section: 'hardware', kinds: ['display'] },
  { key: 'ip_address', label: 'IP address', section: 'network', kinds: ['computer', 'network'], mono: true },
  { key: 'switch_name', label: 'Switch', section: 'network', kinds: ['computer', 'network'], mono: true },
  { key: 'switch_port', label: 'Port #', section: 'network', kinds: ['computer', 'network'], mono: true, max: 40 },
  { key: 'mac_address', label: 'MAC address', section: 'network', kinds: ['computer', 'network'], scan: true, mono: true },
  { key: 'purchase_date', label: 'Purchase date', section: 'purchase', type: 'date' },
  { key: 'warranty_end', label: 'Warranty ends', section: 'purchase', type: 'date' },
  { key: 'cost', label: 'Cost', section: 'purchase', type: 'number' },
  { key: 'notes', label: 'Notes', section: 'notes', type: 'textarea', max: 5000 },
];

const DEFAULT_CATEGORIES = [
  ['Desktop', 'computer'],
  ['Laptop', 'computer'],
  ['Server', 'computer'],
  ['Monitor', 'display'],
  ['TV', 'display'],
  ['Desk phone', 'network'],
  ['Cell phone', 'mobile'],
  ['Tablet', 'mobile'],
  ['Switch', 'network'],
  ['Router', 'network'],
  ['Firewall', 'network'],
  ['Wireless access point', 'network'],
  ['Printer', 'network'],
  ['UPS', 'other'],
  ['Docking station', 'other'],
  ['Peripheral', 'other'],
  ['Other', 'other'],
];

// Append-only: each entry upgrades the schema by one version.
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'tech', 'viewer')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        kind TEXT NOT NULL DEFAULT 'other'
      );
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY,
        tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'in_stock',
        assignee TEXT,
        location TEXT,
        manufacturer TEXT,
        model TEXT,
        serial TEXT COLLATE NOCASE,
        hostname TEXT,
        os TEXT,
        ip_address TEXT,
        mac_address TEXT COLLATE NOCASE,
        firmware TEXT,
        imei TEXT,
        phone_number TEXT,
        carrier TEXT,
        screen_size TEXT,
        purchase_date TEXT,
        warranty_end TEXT,
        cost REAL,
        notes TEXT,
        last_seen_at TEXT,
        last_seen_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX assets_serial ON assets(serial);
      CREATE INDEX assets_imei ON assets(imei);
      CREATE INDEX assets_mac ON assets(mac_address);
      CREATE TABLE asset_events (
        id INTEGER PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX asset_events_asset ON asset_events(asset_id, id);
    `);
    const add = db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)');
    for (const [name, kind] of DEFAULT_CATEGORIES) add.run(name, kind);
  },
  (db) => {
    db.exec(`
      ALTER TABLE assets ADD COLUMN switch_name TEXT;
      ALTER TABLE assets ADD COLUMN switch_port TEXT;
    `);
  },
  (db) => {
    db.exec('ALTER TABLE assets ADD COLUMN implementation_date TEXT');
  },
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

// Runs fn inside a transaction. Nested calls become savepoints, so a failure
// inside rolls back only that inner block.
const depth = new WeakMap();
export function tx(db, fn) {
  const level = depth.get(db) ?? 0;
  const name = `sp${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}
