import express from 'express';
import { ROLES, createLimiter, hashPassword, requireRole, verifyPassword } from '../auth.js';
import { HttpError } from '../assets.js';
import { tx } from '../db.js';

const USERNAME_RE = /^[a-z0-9._@-]{2,64}$/i;

export function checkUsername(value) {
  const s = String(value ?? '').trim();
  if (!USERNAME_RE.test(s)) throw new HttpError(400, 'Usernames are 2–64 letters, numbers, dots, dashes, @ or underscores');
  return s;
}

export function checkDisplayName(value) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 100) throw new HttpError(400, 'Enter a name of up to 100 characters');
  return s;
}

export function checkPassword(value) {
  const s = String(value ?? '');
  if (s.length < 10 || s.length > 200) throw new HttpError(400, 'Passwords need at least 10 characters');
  return s;
}

export function checkRole(value) {
  if (!Object.hasOwn(ROLES, value)) throw new HttpError(400, 'Unknown role');
  return value;
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.display_name ?? u.name, role: u.role });

export function accountRoutes({ db, sessions, config }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const limiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    insert: db.prepare(`INSERT INTO users (username, display_name, password_hash, role, created_at)
                        VALUES (?, ?, ?, ?, ?)`),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  };

  router.get('/setup', (req, res) => {
    res.json({ needed: q.count.get().n === 0, orgName: config.orgName });
  });

  // Creates the first administrator. Refused once any account exists.
  router.post('/setup', json, async (req, res) => {
    if (q.count.get().n > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
    const username = checkUsername(req.body?.username);
    const name = checkDisplayName(req.body?.display_name);
    const hash = await hashPassword(checkPassword(req.body?.password));
    const id = tx(db, () => {
      if (q.count.get().n > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
      return Number(q.insert.run(username, name, hash, 'admin', new Date().toISOString()).lastInsertRowid);
    });
    sessions.start(res, id);
    res.status(201).json({ user: publicUser(q.byId.get(id)) });
  });

  router.post('/login', json, async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    const user = username ? q.byName.get(username) : null;
    const ok = await verifyPassword(password, user?.password_hash);
    if (!ok || !user || !user.active) {
      limiter.fail(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    limiter.clear(key);
    sessions.start(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    sessions.end(req, res);
    res.json({ ok: true });
  });

  router.get('/me', requireRole(), (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/me/password', requireRole(), json, async (req, res) => {
    const user = q.byId.get(req.user.id);
    if (!(await verifyPassword(String(req.body?.current ?? ''), user.password_hash))) {
      throw new HttpError(400, 'Your current password is wrong');
    }
    q.setPassword.run(await hashPassword(checkPassword(req.body?.next)), user.id);
    sessions.endOthersFor(req, user.id);
    res.json({ ok: true });
  });

  return router;
}
