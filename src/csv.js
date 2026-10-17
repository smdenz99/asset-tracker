import { FIELDS, STATUSES, tx } from './db.js';
import { HttpError } from './assets.js';

export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Cells starting with these characters are prefixed with an apostrophe so a
// spreadsheet won't run them as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

export function toCsv(rows) {
  return '﻿' + rows.map((row) => row.map((value) => {
    let s = value == null ? '' : String(value);
    if (FORMULA_START.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

const EXTRA_COLUMNS = [
  ['last_seen_at', 'Last seen'],
  ['last_seen_by_name', 'Last seen by'],
  ['created_at', 'Created'],
  ['updated_at', 'Last updated'],
  ['updated_by_name', 'Last updated by'],
];

export function exportAssets(assets) {
  const header = [...FIELDS.map((f) => f.label), ...EXTRA_COLUMNS.map(([, label]) => label)];
  const rows = assets.map((a) => [
    ...FIELDS.map((f) => {
      if (f.key === 'category_id') return a.category;
      if (f.key === 'status') return STATUSES[a.status] ?? a.status;
      return a[f.key];
    }),
    ...EXTRA_COLUMNS.map(([key]) => a[key]),
  ]);
  return toCsv([header, ...rows]);
}

const DATE_FIELDS = FIELDS.filter((f) => f.type === 'date');
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_MAP = (() => {
  const map = {};
  for (const f of FIELDS) map[norm(f.label)] = f.key === 'category_id' ? 'category' : f.key;
  const synonyms = {
    tag: ['tag', 'asset', 'assetid', 'assetnumber', 'assetno', 'tagnumber', 'tagno', 'barcode'],
    name: ['name', 'description', 'assetname', 'devicename', 'namedescription', 'computername', 'host', 'devicehostname'],
    category: ['type', 'devicetype', 'assettype', 'kind'],
    assignee: ['assignee', 'assignedto', 'owner', 'employee', 'checkedoutto', 'assigneduser', 'username'],
    location: ['room', 'site', 'office', 'building'],
    manufacturer: ['make', 'brand', 'vendor'],
    serial: ['serial', 'sn', 'serialno', 'servicetag'],
    os: ['os'],
    ip_address: ['ip', 'ipv4'],
    mac_address: ['mac'],
    implementation_date: ['implemented', 'implementeddate', 'deploymentdate', 'deployeddate', 'inservicedate', 'golivedate'],
    switch_name:['networkswitch', 'switchname'],
    switch_port: ['port', 'switchport', 'portnumber', 'portno'],
    firmware: ['firmware', 'fw'],
    phone_number: ['phone', 'number', 'mobilenumber', 'cellnumber'],
    screen_size: ['size'],
    purchase_date: ['purchased', 'dateacquired', 'acquired', 'purchasedon'],
    warranty_end: ['warranty', 'warrantyexpires', 'warrantyexpiration', 'warrantyenddate'],
    cost: ['price', 'purchaseprice', 'value'],
    notes: ['note', 'comments', 'comment'],
  };
  for (const [key, names] of Object.entries(synonyms)) for (const n of names) map[n] ??= key;
  return map;
})();

const STATUS_WORDS = {
  in_use: ['inuse', 'assigned', 'deployed', 'active', 'checkedout', 'inservice'],
  in_stock: ['instock', 'stock', 'spare', 'available', 'storage', 'checkedin', 'unassigned', 'new'],
  repair: ['inrepair', 'repair', 'broken', 'rma', 'faulty', 'damaged'],
  lost: ['missing', 'lost', 'stolen'],
  retired: ['retired', 'eol', 'decommissioned', 'inactive'],
  disposed: ['disposed', 'recycled', 'sold', 'donated', 'destroyed'],
};

function toStatus(value) {
  const v = norm(value);
  for (const [key, words] of Object.entries(STATUS_WORDS)) {
    if (v === norm(key) || v === norm(STATUSES[key]) || words.includes(v)) return key;
  }
  throw new HttpError(400, `unknown status "${value}"`);
}

function pad(n) { return String(n).padStart(2, '0'); }

function toIsoDate(value, label) {
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return `${year}-${pad(us[1])}-${pad(us[2])}`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `${label}: "${value}" is not a date`);
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function guessKind(name) {
  const n = name.toLowerCase();
  if (/laptop|desktop|server|computer|workstation|notebook|pc\b|mac/.test(n)) return 'computer';
  if (/phone|mobile|tablet|ipad|cell/.test(n)) return n.includes('desk') || n.includes('voip') ? 'network' : 'mobile';
  if (/switch|router|firewall|access point|\bap\b|wifi|network|printer|nas|camera/.test(n)) return 'network';
  if (/monitor|tv|television|display|projector|screen/.test(n)) return 'display';
  return 'other';
}

// Creates assets whose tag is new and updates the ones that exist. Blank
// cells leave existing values alone. Bad rows are reported and skipped.
export function importAssets(db, store, text, userId) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) throw new HttpError(400, 'The file has a header row but no assets');
  if (rows.length > 20001) throw new HttpError(400, 'Import at most 20,000 rows at a time');
  const columns = rows[0].map((h) => HEADER_MAP[norm(h)] ?? null);
  if (!columns.includes('tag')) {
    throw new HttpError(400, 'The file needs an "Asset tag" column. Export a CSV to see the expected headers.');
  }
  const findCategory = db.prepare('SELECT id FROM categories WHERE name = ?');
  const addCategory = db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)');
  const result = { created: 0, updated: 0, unchanged: 0, newCategories: [], errors: [] };

  // Each row runs in its own savepoint so a bad row leaves nothing behind.
  function importRow(row) {
    const input = {};
    columns.forEach((key, c) => {
      let value = row[c]?.trim();
      if (value && /^'[=+\-@]/.test(value)) value = value.slice(1); // undo the export's formula guard
      if (key && value) input[key] = value;
    });
    if (!input.tag) throw new HttpError(400, 'no asset tag');
    if (input.status) input.status = toStatus(input.status);
    for (const field of DATE_FIELDS) {
      if (input[field.key]) input[field.key] = toIsoDate(input[field.key], field.label);
    }
    let newCategory = null;
    if (input.category) {
      const name = input.category.slice(0, 80);
      let cat = findCategory.get(name);
      if (!cat) {
        cat = { id: Number(addCategory.run(name, guessKind(name)).lastInsertRowid) };
        newCategory = name;
      }
      input.category_id = cat.id;
      delete input.category;
    }
    const existing = store.getByTag(input.tag);
    let outcome;
    if (existing) {
      outcome = store.update(existing.id, input, userId, { action: 'imported' }).changed ? 'updated' : 'unchanged';
    } else {
      store.create(input, userId, { action: 'imported', detail: 'Created by CSV import' });
      outcome = 'created';
    }
    return { outcome, newCategory };
  }

  tx(db, () => {
    rows.slice(1).forEach((row, i) => {
      try {
        const { outcome, newCategory } = tx(db, () => importRow(row));
        result[outcome]++;
        if (newCategory) result.newCategories.push(newCategory);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        if (result.errors.length < 200) result.errors.push({ line: i + 2, message: err.message });
      }
    });
  });
  return result;
}
