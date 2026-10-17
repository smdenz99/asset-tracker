import express from 'express';
import { requireRole, ROLES } from '../auth.js';
import { HttpError } from '../assets.js';
import { exportAssets, importAssets } from '../csv.js';
import { FIELDS, KINDS, STATUSES } from '../db.js';
import { broadcast, stream } from '../events.js';

// Quick actions: what each one sets, and which inputs it accepts.
const ACTIONS = {
  checkout: { event: 'checked_out', set: { status: 'in_use' } }, // "In use"; a user is optional
  checkin: { event: 'checked_in', set: { status: 'in_stock', assignee: null } },
  repair: { event: 'repair', set: { status: 'repair' } },
  missing: { event: 'missing', set: { status: 'lost' } },
  found: { event: 'found', set: { status: 'in_stock' } },
  retire: { event: 'retired', set: { status: 'retired', assignee: null } },
  dispose: { event: 'disposed', set: { status: 'disposed', assignee: null } },
};

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Asset not found');
  return id;
}

const shortText = (value, max = 500) => {
  const s = String(value ?? '').trim();
  if (s.length > max) throw new HttpError(400, `Keep notes under ${max} characters`);
  return s || null;
};

export function assetRoutes({ db, store, config }) {
  const router = express.Router();
  const json = express.json({ limit: '256kb' });
  const changed = (req, ids) => broadcast('assets', { ids, by: req.user.id });
  const withEvents = (asset) => ({ asset, events: store.events(asset.id) });

  router.get('/meta', requireRole(), (req, res) => {
    res.json({
      statuses: STATUSES,
      kinds: KINDS,
      fields: FIELDS,
      roles: ROLES,
      categories: store.categories(),
      orgName: config.orgName,
    });
  });

  router.get('/stream', requireRole(), stream);

  router.get('/assets', requireRole(), (req, res) => {
    res.json({ assets: store.list() });
  });

  router.get('/assets/next-tag', requireRole('tech'), (req, res) => {
    res.json({ tag: store.nextTag(config.tagPrefix, config.tagDigits) });
  });

  router.get('/assets/lookup', requireRole(), (req, res) => {
    res.json({ matches: store.findByCode(req.query.code) });
  });

  router.get('/assets/export.csv', requireRole(), (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    res.attachment(`assets-${date}.csv`);
    res.type('text/csv; charset=utf-8');
    res.send(exportAssets(store.list()));
  });

  router.post('/assets/import', requireRole('tech'), express.json({ limit: '25mb' }), (req, res) => {
    if (typeof req.body?.csv !== 'string') throw new HttpError(400, 'No CSV text was sent');
    const result = importAssets(db, store, req.body.csv, req.user.id);
    if (result.created || result.updated) changed(req, []);
    if (result.newCategories.length) broadcast('categories', {});
    res.json(result);
  });

  router.get('/assets/:id', requireRole(), (req, res) => {
    const asset = store.get(idParam(req));
    if (!asset) throw new HttpError(404, 'Asset not found');
    res.json(withEvents(asset));
  });

  router.post('/assets', requireRole('tech'), json, (req, res) => {
    const asset = store.create(req.body?.fields ?? {}, req.user.id);
    changed(req, [asset.id]);
    res.status(201).json(withEvents(asset));
  });

  router.put('/assets/:id', requireRole('tech'), json, (req, res) => {
    const id = idParam(req);
    const { asset } = store.update(id, req.body?.fields ?? {}, req.user.id, {
      expectedUpdatedAt: req.body?.expected_updated_at,
    });
    changed(req, [id]);
    res.json(withEvents(asset));
  });

  router.post('/assets/:id/action', requireRole('tech'), json, (req, res) => {
    const id = idParam(req);
    const { action, assignee, location, note } = req.body ?? {};
    let asset;
    if (action === 'seen') {
      ({ asset } = store.markSeen(id, req.user.id, { location, note: shortText(note) }));
    } else {
      const spec = ACTIONS[action];
      if (!spec) throw new HttpError(400, 'Unknown action');
      const fields = { ...spec.set };
      if (String(assignee ?? '').trim()) fields.assignee = assignee;
      if (String(location ?? '').trim()) fields.location = location;
      ({ asset } = store.update(id, fields, req.user.id, { action: spec.event, note: shortText(note) }));
    }
    changed(req, [id]);
    res.json(withEvents(asset));
  });

  router.delete('/assets/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    store.remove(id);
    changed(req, [id]);
    res.json({ ok: true });
  });

  // Audit scan: marks the scanned asset as seen in the audited location and
  // moves it there if the register had it somewhere else.
  router.post('/audit/scan', requireRole('tech'), json, (req, res) => {
    const location = String(req.body?.location ?? '').trim();
    if (!location) throw new HttpError(400, 'Choose the location you are auditing');
    const matches = store.findByCode(req.body?.code);
    if (!matches.length) throw new HttpError(404, 'Not in the register', { code: 'unknown' });
    if (matches.length > 1) throw new HttpError(409, `${matches.length} assets share that serial number. Scan the asset tag instead.`);
    const result = store.markSeen(matches[0].id, req.user.id, { location });
    changed(req, [matches[0].id]);
    res.json({ asset: result.asset, moved: result.moved, from: result.from ?? null });
  });

  return router;
}
