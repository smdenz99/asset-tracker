import { FIELDS, STATUSES, tx } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SELECT = `
  SELECT a.*, c.name AS category, c.kind AS kind,
         su.display_name AS last_seen_by_name, uu.display_name AS updated_by_name
  FROM assets a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN users su ON su.id = a.last_seen_by
  LEFT JOIN users uu ON uu.id = a.updated_by`;

export function normalizeMac(value) {
  const hex = value.replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? hex.toUpperCase().match(/../g).join(':') : value;
}

export function createAssetStore(db) {
  const q = {
    all: db.prepare(`${SELECT} ORDER BY a.tag`),
    byId: db.prepare(`${SELECT} WHERE a.id = ?`),
    byTag: db.prepare(`${SELECT} WHERE a.tag = ?`),
    byIdentifier: db.prepare(`${SELECT}
      WHERE a.serial = $code OR a.imei = $code OR a.mac_address = $mac LIMIT 20`),
    tagOwner: db.prepare('SELECT id FROM assets WHERE tag = ?'),
    category: db.prepare('SELECT id, name FROM categories WHERE id = ?'),
    categories: db.prepare(`
      SELECT c.id, c.name, c.kind, COUNT(a.id) AS count
      FROM categories c LEFT JOIN assets a ON a.category_id = c.id
      GROUP BY c.id ORDER BY c.name`),
    events: db.prepare(`
      SELECT e.id, e.at, e.action, e.detail, u.display_name AS by
      FROM asset_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.asset_id = ? ORDER BY e.id DESC LIMIT 200`),
    addEvent: db.prepare('INSERT INTO asset_events (asset_id, at, user_id, action, detail) VALUES (?, ?, ?, ?, ?)'),
    tagsLike: db.prepare(`SELECT tag FROM assets WHERE tag LIKE ? ESCAPE '\\'`),
    remove: db.prepare('DELETE FROM assets WHERE id = ?'),
    seen: db.prepare('UPDATE assets SET last_seen_at = ?, last_seen_by = ? WHERE id = ?'),
  };

  function categoryName(id) {
    return id == null ? 'Uncategorized' : (q.category.get(id)?.name ?? 'Unknown');
  }

  function cleanValue(key, raw) {
    const field = FIELD_BY_KEY[key];
    const blank = raw == null || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      if (key === 'tag') throw new HttpError(400, 'Asset tag is required');
      return key === 'status' ? 'in_stock' : null;
    }
    switch (field.type) {
      case 'category': {
        const id = Number(raw);
        if (!Number.isInteger(id) || !q.category.get(id)) throw new HttpError(400, 'Unknown category');
        return id;
      }
      case 'status':
        if (!Object.hasOwn(STATUSES, raw)) throw new HttpError(400, `Unknown status "${raw}"`);
        return raw;
      case 'date': {
        const s = String(raw).trim();
        if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
          throw new HttpError(400, `${field.label} must be a date (YYYY-MM-DD)`);
        }
        return s;
      }
      case 'number': {
        const n = Number(String(raw).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field.label} must be a positive number`);
        return Math.round(n * 100) / 100;
      }    }
    let s = String(raw).replace(CONTROL_CHARS, '').trim();
    if (key !== 'notes') s = s.replace(/\s+/g, ' ');
    const max = field.max ?? 200;
    if (s.length > max) throw new HttpError(400, `${field.label} is longer than ${max} characters`);
    if (key === 'mac_address') s = normalizeMac(s);
    return s;
  }

  // Keeps only known fields and validates each one that was supplied.
  function clean(input) {
    const out = {};
    for (const key of Object.keys(FIELD_BY_KEY)) {
      if (Object.hasOwn(input ?? {}, key)) out[key] = cleanValue(key, input[key]);
    }
    return out;
  }

  function describeChanges(before, changes) {
    const lines = [];
    const edited = [];
    for (const [key, value] of Object.entries(changes)) {
      const was = before[key] ?? null;
      if (key === 'status') lines.push(`Status: ${STATUSES[was] ?? was} → ${STATUSES[value]}`);
      else if (key === 'assignee') lines.push(value ? `Assigned to ${value}${was ? ` (was ${was})` : ''}` : `Unassigned from ${was}`);
      else if (key === 'location') lines.push(value ? `Moved to ${value}${was ? ` (from ${was})` : ''}` : `Location cleared (was ${was})`);
      else if (key === 'category_id') lines.push(`Category: ${categoryName(was)} → ${categoryName(value)}`);
      else if (key === 'tag') lines.push(`Tag changed from ${was} to ${value}`);
      else edited.push(FIELD_BY_KEY[key].label.toLowerCase());
    }
    if (edited.length) lines.push(`Edited ${edited.join(', ')}`);
    return lines.join('; ');
  }

  function assertTagFree(tag, id) {
    const owner = q.tagOwner.get(tag);
    if (owner && owner.id !== id) throw new HttpError(409, `Asset tag ${tag} is already in use`);
  }

  function addEvent(assetId, userId, action, detail) {
    q.addEvent.run(assetId, new Date().toISOString(), userId ?? null, action, detail || null);
  }

  const store = {
    clean,
    list: () => q.all.all(),
    get: (id) => q.byId.get(id),
    getByTag: (tag) => q.byTag.get(tag),
    events: (id) => q.events.all(id),
    categories: () => q.categories.all(),

    // An exact tag match wins; otherwise serial, IMEI and MAC are searched.
    findByCode(code) {
      const c = String(code ?? '').replace(CONTROL_CHARS, '').trim();
      if (!c) return [];
      const byTag = q.byTag.get(c);
      if (byTag) return [byTag];
      return q.byIdentifier.all({ code: c, mac: normalizeMac(c) });
    },

    create(input, userId, { action = 'created', detail } = {}) {
      const fields = clean({ status: 'in_stock', ...input });
      if (!fields.tag) throw new HttpError(400, 'Asset tag is required');
      return tx(db, () => {
        assertTagFree(fields.tag);
        const now = new Date().toISOString();
        const row = { ...fields, created_at: now, created_by: userId, updated_at: now, updated_by: userId };
        const cols = Object.keys(row);
        const { lastInsertRowid } = db
          .prepare(`INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
          .run(row);
        const id = Number(lastInsertRowid);
        addEvent(id, userId, action, detail ?? `Created as ${STATUSES[fields.status]}`);
        return q.byId.get(id);
      });
    },

    // Applies the supplied fields. Pass expectedUpdatedAt to refuse the write
    // when someone else saved the asset after the caller loaded it.
    update(id, input, userId, { expectedUpdatedAt, action = 'updated', note } = {}) {
      const fields = clean(input);
      return tx(db, () => {
        const before = q.byId.get(id);
        if (!before) throw new HttpError(404, 'Asset not found');
        if (expectedUpdatedAt && expectedUpdatedAt !== before.updated_at) {
          throw new HttpError(409, 'Someone else changed this asset while you were editing it', { asset: before });
        }
        if (fields.tag) assertTagFree(fields.tag, id);
        const changes = {};
        for (const [key, value] of Object.entries(fields)) {
          if ((before[key] ?? null) !== value) changes[key] = value;
        }
        const keys = Object.keys(changes);
        if (!keys.length && !note) return { asset: before, changed: false };
        if (keys.length) {
          const sets = [...keys.map((k) => `${k} = :${k}`), 'updated_at = :updated_at', 'updated_by = :updated_by'];
          db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = :id`)
            .run({ ...changes, updated_at: new Date().toISOString(), updated_by: userId, id });
        }
        const detail = [describeChanges(before, changes), note].filter(Boolean).join('; ');
        addEvent(id, userId, action, detail || 'No changes');
        return { asset: q.byId.get(id), changed: keys.length > 0 };
      });
    },

    // Records that someone physically saw the asset, optionally moving it.
    markSeen(id, userId, { location, note } = {}) {
      return tx(db, () => {
        const before = q.byId.get(id);
        if (!before) throw new HttpError(404, 'Asset not found');
        const now = new Date().toISOString();
        q.seen.run(now, userId, id);
        const where = location ? cleanValue('location', location) : null;
        const moved = where && where.toLowerCase() !== (before.location ?? '').toLowerCase();
        if (moved) {
          return {
            ...store.update(id, { location: where }, userId, { action: 'moved', note: note ?? 'Seen during audit' }),
            moved: true,
            from: before.location,
          };
        }
        addEvent(id, userId, 'seen', [where ? `Seen in ${where}` : 'Seen', note].filter(Boolean).join('; '));
        return { asset: q.byId.get(id), changed: false, moved: false };
      });
    },

    remove(id) {
      const { changes } = q.remove.run(id);
      if (!changes) throw new HttpError(404, 'Asset not found');
    },

    // Next free tag after the highest number already used with this prefix.
    nextTag(prefix, width) {
      const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
      let max = 0;
      for (const { tag } of q.tagsLike.all(like)) {
        const rest = tag.slice(prefix.length);
        if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
      }
      return prefix + String(max + 1).padStart(width, '0');
    },
  };
  return store;
}
