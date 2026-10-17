import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessions, csrfGuard } from './auth.js';
import { createAssetStore, HttpError } from './assets.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { assetRoutes } from './routes/assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  });
  next();
}

export function createApp({ db, config }) {
  const app = express();
  const sessions = createSessions(db, { secure: config.secureCookies });
  const store = createAssetStore(db);

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  app.use('/api', sessions.middleware, csrfGuard, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', accountRoutes({ db, sessions, config }));
  app.use('/api', assetRoutes({ db, store, config }));
  app.use('/api', adminRoutes({ db, sessions }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const vendor = (dir) => express.static(path.join(root, 'node_modules', dir), { maxAge: '7d' });
  app.use('/vendor/zxing', vendor('@zxing/library/umd'));
  app.use('/vendor/jsbarcode', vendor('jsbarcode/dist'));
  app.use(express.static(path.join(root, 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return { app, sessions };
}
