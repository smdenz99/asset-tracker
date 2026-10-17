import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { disconnectAll } from './events.js';

const env = process.env;
const useHttps = Boolean(env.HTTPS_CERT && env.HTTPS_KEY);
const config = {
  port: Number(env.PORT) || (useHttps ? 3443 : 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  orgName: env.ORG_NAME || 'IT Asset',
  tagPrefix: env.TAG_PREFIX ?? 'IT-',
  tagDigits: Number(env.TAG_DIGITS) || 5,
  // Behind a reverse proxy that terminates HTTPS, set TRUST_PROXY=1 and SECURE_COOKIES=1.
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : false,
  secureCookies: useHttps || env.SECURE_COOKIES === '1',
};

const db = openDb(path.join(config.dataDir, 'assets.db'));
const { app, sessions } = createApp({ db, config });

const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(env.HTTPS_CERT), key: fs.readFileSync(env.HTTPS_KEY) }, app)
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`Asset tracker running at ${scheme}://localhost:${config.port}`);
  console.log(`Database: ${path.join(config.dataDir, 'assets.db')}`);
  if (!useHttps) {
    console.log('Live camera scanning on phones needs HTTPS. See README.md, "Phones and HTTPS".');
  }
});

sessions.purgeExpired();
setInterval(() => sessions.purgeExpired(), 60 * 60 * 1000).unref();

function shutdown() {
  disconnectAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
