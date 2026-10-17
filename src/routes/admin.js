import express from 'express';
import { hashPassword, requireRole } from '../auth.js';
import { HttpError } from '../assets.js';
import { KINDS, tx } from '../db.js';
import { broadcast, disconnectUser } from '../events.js';
import { checkDisplayName, checkPassword, checkRole, checkUsername } from './account.js';

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

function checkCategoryName(value) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 80) throw new HttpError(400, 'Category names are 1–80 characters');
  return s;
}

function checkKind(value) {
  if (!Object.hasOwn(KINDS, value)) throw new HttpError(400, 'Unknown device type');
  return value;
}

export function adminRoutes({ db, sessions }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const admin = requireRole('admin');
  const q = {
    users: db.prepare(`SELECT id, username, display_name AS name, role, active, created_at
                       FROM users ORDER BY active DESC, display_name`),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    nameTaken: db.prepare('SELECT id FROM users WHERE username = ?'),
    insertUser: db.prepare(`INSERT INTO users (username, display_name, password_hash, role, created_at)
                            VALUES (?, ?, ?, ?, ?)`),
    activeAdmins: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`),
    categoryTaken: db.prepare('SELECT id FROM categories WHERE name = ? AND id <> ?'),
    insertCategory: db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)'),
    categoryInUse: db.prepare('SELECT COUNT(*) AS n FROM assets WHERE category_id = ?'),
    deleteCategory: db.prepare('DELETE FROM categories WHERE id = ?'),
  };

  router.get('/users', admin, (req, res) => {
    res.json({ users: q.users.all().map((u) => ({ ...u, active: !!u.active })) });
  });

  router.post('/users', admin, json, async (req, res) => {
    const username = checkUsername(req.body?.username);
    const name = checkDisplayName(req.body?.name);
    const role = checkRole(req.body?.role);
    const hash = await hashPassword(checkPassword(req.body?.password));
    if (q.nameTaken.get(username)) throw new HttpError(409, `The username ${username} is taken`);
    q.insertUser.run(username, name, hash, role, new Date().toISOString());
    res.status(201).json({ ok: true });
  });

  router.patch('/users/:id', admin, json, async (req, res) => {
    const id = idParam(req);
    const body = req.body ?? {};
    const hash = body.password !== undefined ? await hashPassword(checkPassword(body.password)) : null;
    tx(db, () => {
      const user = q.user.get(id);
      if (!user) throw new HttpError(404, 'User not found');
      const sets = {};
      if (body.name !== undefined) sets.display_name = checkDisplayName(body.name);
      if (body.role !== undefined) sets.role = checkRole(body.role);
      if (body.active !== undefined) sets.active = body.active ? 1 : 0;
      if (hash) sets.password_hash = hash;
      const losesAdmin = user.role === 'admin' && user.active && (sets.active === 0 || (sets.role && sets.role !== 'admin'));
      if (losesAdmin && q.activeAdmins.get(id).n === 0) {
        throw new HttpError(400, 'Keep at least one active administrator');
      }
      const keys = Object.keys(sets);
      if (!keys.length) return;
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`).run({ ...sets, id });
      if (sets.active === 0 || hash || (sets.role && sets.role !== user.role)) {
        sessions.endAllFor(id);
        disconnectUser(id);
      }
    });
    res.json({ ok: true });
  });

  router.post('/categories', admin, json, (req, res) => {
    const name = checkCategoryName(req.body?.name);
    const kind = checkKind(req.body?.kind ?? 'other');
    if (q.categoryTaken.get(name, 0)) throw new HttpError(409, `There is already a ${name} category`);
    q.insertCategory.run(name, kind);
    broadcast('categories', {});
    res.status(201).json({ ok: true });
  });

  router.patch('/categories/:id', admin, json, (req, res) => {
    const id = idParam(req);
    const sets = {};
    if (req.body?.name !== undefined) {
      sets.name = checkCategoryName(req.body.name);
      if (q.categoryTaken.get(sets.name, id)) throw new HttpError(409, `There is already a ${sets.name} category`);
    }
    if (req.body?.kind !== undefined) sets.kind = checkKind(req.body.kind);
    const keys = Object.keys(sets);
    if (keys.length) {
      const { changes } = db.prepare(`UPDATE categories SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`)
        .run({ ...sets, id });
      if (!changes) throw new HttpError(404, 'Category not found');
      broadcast('categories', {});
      broadcast('assets', { ids: [], by: req.user.id });
    }
    res.json({ ok: true });
  });

  router.delete('/categories/:id', admin, (req, res) => {
    const id = idParam(req);
    const { n } = q.categoryInUse.get(id);
    if (n) throw new HttpError(409, `${n} asset${n === 1 ? ' uses' : 's use'} this category. Move them first.`);
    q.deleteCategory.run(id);
    broadcast('categories', {});
    res.json({ ok: true });
  });

  return router;
}
