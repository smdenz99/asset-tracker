import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const config = { orgName: 'Test IT', tagPrefix: 'IT-', tagDigits: 5, secureCookies: false, trustProxy: false };
let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  const { app } = createApp({ db, config });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// A tiny client that keeps its own session cookie.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Requested-With': 'fetch',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

describe('asset tracker API', () => {
  const admin = client();
  const tech = client();
  const viewer = client();
  let laptop;

  test('first run creates the admin, then setup is closed', async () => {
    assert.equal((await admin('/setup')).data.needed, true);
    const res = await admin('/setup', { method: 'POST', body: { display_name: 'Ada Admin', username: 'ada', password: 'correct horse battery' } });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.role, 'admin');
    assert.equal((await admin('/setup')).data.needed, false);
    const again = await client()('/setup', { method: 'POST', body: { display_name: 'X', username: 'x', password: 'another password' } });
    assert.equal(again.status, 409);
  });

  test('writes without the X-Requested-With header are rejected', async () => {
    const res = await admin('/assets', { method: 'POST', body: { fields: { tag: 'X' } }, headers: { 'X-Requested-With': '' } });
    assert.equal(res.status, 403);
  });

  test('admin adds team members and they can sign in', async () => {
    for (const [username, role] of [['tom', 'tech'], ['vic', 'viewer']]) {
      const res = await admin('/users', { method: 'POST', body: { name: username, username, role, password: 'temporary-pass-1' } });
      assert.equal(res.status, 201);
    }
    assert.equal((await tech('/login', { method: 'POST', body: { username: 'tom', password: 'wrong password!' } })).status, 401);
    assert.equal((await tech('/login', { method: 'POST', body: { username: 'TOM', password: 'temporary-pass-1' } })).status, 200);
    assert.equal((await viewer('/login', { method: 'POST', body: { username: 'vic', password: 'temporary-pass-1' } })).status, 200);
    assert.equal((await client()('/assets')).status, 401);
  });

  test('technician creates an asset with the next tag', async () => {
    const { data: meta } = await tech('/meta');
    const laptopCat = meta.categories.find((c) => c.name === 'Laptop');
    const { data: next } = await tech('/assets/next-tag');
    assert.equal(next.tag, 'IT-00001');
    const res = await tech('/assets', {
      method: 'POST',
      body: { fields: { tag: next.tag, name: 'ThinkPad T14', category_id: laptopCat.id, serial: 'PF3ABC12', mac_address: 'aa-bb-cc-dd-ee-ff', cost: '$1,249.50' } },
    });
    assert.equal(res.status, 201);
    laptop = res.data.asset;
    assert.equal(laptop.mac_address, 'AA:BB:CC:DD:EE:FF');
    assert.equal(laptop.cost, 1249.5);
    assert.equal(laptop.category, 'Laptop');
    assert.equal(res.data.events[0].action, 'created');
    assert.equal((await tech('/assets/next-tag')).data.tag, 'IT-00002');
  });

  test('duplicate tags are refused, case-insensitively', async () => {
    const res = await tech('/assets', { method: 'POST', body: { fields: { tag: 'it-00001' } } });
    assert.equal(res.status, 409);
  });

  test('viewers can read but not write', async () => {
    assert.equal((await viewer('/assets')).data.assets.length, 1);
    assert.equal((await viewer('/assets', { method: 'POST', body: { fields: { tag: 'V-1' } } })).status, 403);
  });

  test('lookup finds by tag, serial and MAC', async () => {
    for (const code of ['IT-00001', 'it-00001', 'pf3abc12', 'aabbccddeeff']) {
      const { data } = await viewer(`/assets/lookup?code=${encodeURIComponent(code)}`);
      assert.equal(data.matches.length, 1, code);
      assert.equal(data.matches[0].id, laptop.id);
    }
    assert.equal((await viewer('/assets/lookup?code=NOPE')).data.matches.length, 0);
  });

  test('edits record history and stale saves get a conflict', async () => {
    const first = await tech(`/assets/${laptop.id}`, {
      method: 'PUT',
      body: { fields: { location: 'Room 210', notes: 'New battery' }, expected_updated_at: laptop.updated_at },
    });
    assert.equal(first.status, 200);
    assert.match(first.data.events[0].detail, /Moved to Room 210/);
    const stale = await admin(`/assets/${laptop.id}`, {
      method: 'PUT',
      body: { fields: { name: 'Overwrite' }, expected_updated_at: laptop.updated_at },
    });
    assert.equal(stale.status, 409);
    laptop = first.data.asset;
  });

  test('check out and check in', async () => {
    const out = await tech(`/assets/${laptop.id}/action`, { method: 'POST', body: { action: 'checkout', assignee: 'Jane Doe' } });
    assert.equal(out.data.asset.status, 'in_use');
    assert.equal(out.data.asset.assignee, 'Jane Doe');
    const noUser = await tech(`/assets/${laptop.id}/action`, { method: 'POST', body: { action: 'checkout' } });
    assert.equal(noUser.status, 200);
    assert.equal(noUser.data.asset.assignee, 'Jane Doe'); // marking in use keeps the current user
    const back = await tech(`/assets/${laptop.id}/action`, { method: 'POST', body: { action: 'checkin', location: 'IT storage' } });
    assert.equal(back.data.asset.status, 'in_stock');
    assert.equal(back.data.asset.assignee, null);
    assert.equal(back.data.asset.location, 'IT storage');
  });

  test('audit scan marks seen and moves the asset', async () => {
    const res = await tech('/audit/scan', { method: 'POST', body: { code: 'PF3ABC12', location: 'Room 105' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.moved, true);
    assert.equal(res.data.from, 'IT storage');
    assert.equal(res.data.asset.location, 'Room 105');
    assert.ok(res.data.asset.last_seen_at);
    const again = await tech('/audit/scan', { method: 'POST', body: { code: 'IT-00001', location: 'room 105' } });
    assert.equal(again.data.moved, false);
    assert.equal((await tech('/audit/scan', { method: 'POST', body: { code: 'ZZZ', location: 'Room 105' } })).status, 404);
  });

  test('CSV import creates, updates and reports bad rows', async () => {
    const csv = [
      'Asset Tag,Description,Type,Status,Assigned To,Serial Number,Purchase Date,Warranty,Cost',
      'IT-00001,,,,,,,,',
      'IT-00050,"Dell U2723QE, 27""",Monitor,Deployed,Sam Lee,CN0ABC,3/15/2024,2027-03-15,519.99',
      'IT-00051,Galaxy S24,Cell phone,spare,,R5CX1,,,',
      'SW-01,Core switch,Network switch,in stock,,FOC123,,,',
      'IT-00052,Bad row,Laptop,exploded,,,,,',
      ',No tag,Laptop,,,,,,',
    ].join('\r\n');
    const res = await tech('/assets/import', { method: 'POST', body: { csv } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.created, 3);
    assert.equal(res.data.unchanged, 1);
    assert.deepEqual(res.data.newCategories, ['Network switch']);
    assert.deepEqual(res.data.errors.map((e) => e.line), [6, 7]);
    const { data } = await tech('/assets/lookup?code=IT-00050');
    const monitor = data.matches[0];
    assert.equal(monitor.name, 'Dell U2723QE, 27"');
    assert.equal(monitor.status, 'in_use');
    assert.equal(monitor.purchase_date, '2024-03-15');
    assert.equal(monitor.category, 'Monitor');
    const { data: meta } = await tech('/meta');
    assert.equal(meta.categories.find((c) => c.name === 'Network switch').kind, 'network');
  });

  test('CSV export round-trips the headers and guards formulas', async () => {
    await tech('/assets', { method: 'POST', body: { fields: { tag: 'IT-00060', name: '=HYPERLINK("x")' } } });
    const res = await viewer('/assets/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /assets-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = res.data.replace(/^﻿/, '').split('\r\n');
    assert.match(lines[0], /^Asset tag,Category,Hostname,Status,User,Location/);
    assert.ok(res.data.includes(`"'=HYPERLINK(""x"")"`));
    const reimport = await tech('/assets/import', { method: 'POST', body: { csv: res.data } });
    assert.equal(reimport.data.errors.length, 0, JSON.stringify(reimport.data.errors));
    assert.equal(reimport.data.created, 0);
  });

  test('only admins delete, and the last admin cannot be demoted', async () => {
    assert.equal((await tech(`/assets/${laptop.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await admin(`/assets/${laptop.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await admin(`/assets/${laptop.id}`)).status, 404);
    const { data } = await admin('/users');
    const me = data.users.find((u) => u.username === 'ada');
    assert.equal((await admin(`/users/${me.id}`, { method: 'PATCH', body: { role: 'tech' } })).status, 400);
  });

  test('deactivating a user ends their session', async () => {
    const { data } = await admin('/users');
    const vic = data.users.find((u) => u.username === 'vic');
    assert.equal((await admin(`/users/${vic.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
    assert.equal((await viewer('/assets')).status, 401);
  });

  test('categories in use cannot be deleted', async () => {
    const { data } = await admin('/meta');
    const monitor = data.categories.find((c) => c.name === 'Monitor');
    assert.equal((await admin(`/categories/${monitor.id}`, { method: 'DELETE' })).status, 409);
    const tv = data.categories.find((c) => c.name === 'TV');
    assert.equal((await admin(`/categories/${tv.id}`, { method: 'DELETE' })).status, 200);
  });
});
