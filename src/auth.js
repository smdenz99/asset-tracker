import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const ROLES = { viewer: 'Viewer', tech: 'Technician', admin: 'Administrator' };
const RANK = { viewer: 0, tech: 1, admin: 2 };
const COOKIE = 'at_sid';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

let dummyHash;
export async function verifyPassword(password, stored) {
  // Hash something even for unknown users so response time doesn't reveal
  // which usernames exist.
  if (!stored) {
    dummyHash ??= await hashPassword('not-a-real-password');
    stored = dummyHash;
    password = `${password}\0`;
  }
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function createSessions(db, { secure }) {
  const q = {
    insert: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    find: db.prepare(`
      SELECT s.expires_at, u.id, u.username, u.display_name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1`),
    extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    remove: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    removeUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    removeOthers: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };
  const cookie = (value, maxAgeMs) =>
    [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, secure && 'Secure']
      .filter(Boolean).join('; ');

  return {
    start(res, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      q.insert.run(sha256(token), userId, Date.now() + SESSION_MS);
      res.append('Set-Cookie', cookie(token, SESSION_MS));
    },
    end(req, res) {
      const token = readCookie(req.headers.cookie, COOKIE);
      if (token) q.remove.run(sha256(token));
      res.append('Set-Cookie', cookie('', 0));
    },
    endAllFor(userId) {
      q.removeUser.run(userId);
    },
    endOthersFor(req, userId) {
      const token = readCookie(req.headers.cookie, COOKIE);
      if (token) q.removeOthers.run(userId, sha256(token));
    },
    purgeExpired() {
      q.purge.run(Date.now());
    },
    // Sets req.user from the session cookie and slides the expiry forward.
    middleware(req, res, next) {
      const token = readCookie(req.headers.cookie, COOKIE);
      if (token) {
        const hash = sha256(token);
        const row = q.find.get(hash);
        const now = Date.now();
        if (row && row.expires_at > now) {
          req.user = { id: row.id, username: row.username, name: row.display_name, role: row.role };
          if (row.expires_at - now < SESSION_MS / 2) {
            q.extend.run(now + SESSION_MS, hash);
            res.append('Set-Cookie', cookie(token, SESSION_MS));
          }
        }
      }
      next();
    },
  };
}

export function requireRole(min = 'viewer') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in' });
    if (RANK[req.user.role] < RANK[min]) return res.status(403).json({ error: "Your role can't do that" });
    next();
  };
}

// Browsers can't add custom headers to cross-site form posts, so requiring
// one on every write blocks cross-site request forgery.
export function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.get('x-requested-with') === 'fetch') return next();
  res.status(403).json({ error: 'Request rejected' });
}

export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const live = (key) => {
    const h = hits.get(key);
    if (h && Date.now() - h.first > windowMs) { hits.delete(key); return null; }
    return h;
  };
  return {
    blocked: (key) => (live(key)?.count ?? 0) >= max,
    fail(key) {
      const h = live(key);
      if (h) h.count++;
      else {
        if (hits.size > 10000) hits.clear();
        hits.set(key, { count: 1, first: Date.now() });
      }
    },
    clear: (key) => hits.delete(key),
  };
}
