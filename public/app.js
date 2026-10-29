import { CameraScanner, decodeImageFile } from './scanner.js';

const RANK = { viewer: 0, tech: 1, admin: 2 };
const STATUS_TONE = { in_stock: 'info', in_use: 'ok', repair: 'warn', lost: 'crit', retired: 'idle', disposed: 'idle' };
const CLOSED_STATUSES = ['retired', 'disposed'];
const HIDDEN_STAT_CHIPS = ['in_stock']; // status counters left off the main page
const SECTIONS = [
  ['identity', ''], // no heading: the form opens straight on Asset tag and Category
  ['hardware', 'Asset info'],
  ['assignment', 'User information'],
  ['network', 'Network info'],
  ['purchase', 'Purchase and warranty'],
  ['notes', 'Notes'],
];
const LABEL_SIZES = {
  '2.25x1.25': [2.25, 1.25, 'in'],
  '2x1': [2, 1, 'in'],
  '1.5x1': [1.5, 1, 'in'],
  '3x2': [3, 2, 'in'],
  '4x2': [4, 2, 'in'],
  '62x29mm': [62, 29, 'mm'],
};
const ACTION_COPY = {
  checkin: { title: 'Check in', fields: ['location'], submit: 'Check in' },
  repair: { title: 'Send to repair', fields: [], submit: 'Send to repair' },
  missing: { title: 'Mark as missing', fields: [], submit: 'Mark missing' },
  retire: { title: 'Retire', fields: [], submit: 'Retire' },
  dispose: { title: 'Dispose', fields: [], submit: 'Dispose' },
};
const PAGE = 300;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
  },
};

const state = {
  me: null,
  meta: null,
  assets: [],
  byId: new Map(),
  filter: { q: '', status: '', category: '', location: '', warranty: false },
  sort: { key: 'tag', dir: 1 },
  limit: PAGE,
  current: null, // { asset, events } for an existing asset, { asset: null } for a new one
  dirty: false,
  audit: { on: false, location: '', scanned: {}, unknown: [] },
  labelTargets: [],
};

const can = (role) => RANK[state.me?.role] >= RANK[role];
const statusLabel = (s) => state.meta?.statuses[s] ?? s;

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !quiet) {
    signedOut();
    throw new ApiError('Your session ended. Sign in again.', 401);
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data);
  return data;
}

// ---------------------------------------------------------------- Toasts and formatting

function toast(message, { tone = '', action, timeout = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${tone ? `tone-${tone}` : ''}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.fn(); });
    el.append(btn);
  }
  // An open modal dialog makes the rest of the page inert, so the toast
  // stack moves into the topmost dialog to stay visible and clickable.
  const stack = $('#toasts');
  const host = $$('dialog[open]').at(-1) ?? document.body;
  if (stack.parentElement !== host) host.append(stack);
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => el.remove(), action ? timeout * 2 : timeout);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${dateStr}T00:00:00`) - today) / 86400000);
}

const assetTitle = (a) => a.name || [a.manufacturer, a.model].filter(Boolean).join(' ') || a.category || 'Unnamed asset';
const sameLocation = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

// Any [data-close] button closes its dialog.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close]');
  if (btn) btn.closest('dialog')?.close();
});

// ---------------------------------------------------------------- Sign in

let authMode = 'login';

async function showAuth() {
  $('#mainView').hidden = true;
  $('#boot').hidden = true;
  let setup = false;
  try {
    const info = await api('/setup', { quiet: true });
    setup = info.needed;
    $('#authOrgName').textContent = info.orgName;
    document.title = info.orgName;
  } catch { /* show sign in */ }
  authMode = setup ? 'setup' : 'login';
  $('#authTitle').textContent = setup ? 'Set up the asset tracker' : 'Sign in';
  $('#authIntro').hidden = !setup;
  $('#authIntro').textContent = 'Create the first administrator account. You can add the rest of the team after this.';
  $('#displayNameField').hidden = !setup;
  $('#authForm').password.autocomplete = setup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = setup ? 'Create account' : 'Sign in';
  $('#authError').textContent = '';
  $('#authView').hidden = false;
  $(setup ? '#authForm [name=display_name]' : '#authForm [name=username]').focus();
}

function signedOut() {
  if (!state.me) return;
  state.me = null;
  state.events?.close();
  $$('dialog[open]').forEach((d) => d.close());
  showAuth();
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  $('#authSubmit').disabled = true;
  try {
    const { user } = await api(authMode === 'setup' ? '/setup' : '/login', { method: 'POST', body, quiet: true });
    state.me = user;
    form.reset();
    await startApp();
  } catch (err) {
    $('#authError').textContent = err.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
});

// ---------------------------------------------------------------- Start up

async function boot() {
  try {
    state.me = (await api('/me', { quiet: true })).user;
    await startApp();
  } catch (err) {
    if (err.status === 401) showAuth();
    else $('#boot').textContent = err.message;
  }
}

async function startApp() {
  const [meta, list] = await Promise.all([api('/meta'), api('/assets')]);
  state.meta = meta;
  document.body.classList.toggle('can-edit', can('tech'));
  document.body.classList.toggle('is-admin', can('admin'));
  $('#orgName').textContent = meta.orgName;
  document.title = meta.orgName;
  $('#meName').textContent = state.me.name;
  $('#meRole').textContent = meta.roles[state.me.role];
  $('#adminBtn').hidden = !can('admin');
  buildAssetForm();
  renderCategoryFilter();
  setAssets(list.assets);
  restoreAudit();
  $('#authView').hidden = true;
  $('#boot').hidden = true;
  $('#mainView').hidden = false;
  if (matchMedia('(pointer: fine)').matches) $('#scanInput').focus();
  connectEvents();
  if (location.hash === '#new') openNew();
}

function setAssets(assets) {
  state.assets = assets;
  state.byId = new Map(assets.map((a) => [a.id, a]));
  for (const a of assets) {
    a._search = [a.tag, a.name, a.category, a.assignee, a.location, a.manufacturer, a.model, a.serial,
      a.hostname, a.ip_address, a.mac_address, a.switch_name, a.imei, a.phone_number, a.notes].filter(Boolean).join(' ').toLowerCase();
  }
  fillDatalist('#locationList', assets.map((a) => a.location));
  fillDatalist('#assigneeList', assets.map((a) => a.assignee));
  renderLocationFilter();
  renderRegister();
  renderAudit();
}

function fillDatalist(sel, values) {
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $(sel).replaceChildren(...unique.map((v) => Object.assign(document.createElement('option'), { value: v })));
}

async function reloadAssets() {
  setAssets((await api('/assets')).assets);
}

async function reloadMeta() {
  state.meta = await api('/meta');
  // Rebuilding the form wipes it, so carry over anything being edited.
  const editing = $('#assetDialog').open ? readAssetForm() : null;
  buildAssetForm();
  renderCategoryFilter();
  if (editing) fillAssetForm(editing);
}

// ---------------------------------------------------------------- Live updates

let reloadTimer;
let changedIds = new Set();

function connectEvents() {
  state.events?.close();
  const es = new EventSource('/api/stream');
  state.events = es;
  es.addEventListener('assets', (e) => {
    const { ids, by } = JSON.parse(e.data);
    if (ids.length === 0) changedIds.add('*');
    if (by !== state.me?.id) ids.forEach((id) => changedIds.add(id));
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(applyRemoteChanges, 300);
  });
  es.addEventListener('categories', () => reloadMeta().catch(() => {}));
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(() => api('/me').then(connectEvents).catch(() => {}), 5000);
  });
}

async function applyRemoteChanges() {
  const ids = changedIds;
  changedIds = new Set();
  try { await reloadAssets(); } catch { return; }
  const open = state.current?.asset;
  if (!open || !$('#assetDialog').open || !(ids.has(open.id) || ids.has('*'))) return;
  const latest = state.byId.get(open.id);
  if (!latest) {
    showNotice('Someone deleted this asset.');
    return;
  }
  if (latest.updated_at === open.updated_at && latest.last_seen_at === open.last_seen_at) return;
  if (state.dirty) {
    showNotice('Someone else just changed this asset. Saving will fail until you reload it.', { label: 'Reload', fn: () => openAsset(open.id) });
  } else {
    openAsset(open.id, { quiet: true });
  }
}

// ---------------------------------------------------------------- Register

// Category filter value for assets with no category. Real values are numeric IDs.
const UNCATEGORIZED = 'none';

function renderCategoryFilter() {
  const sel = $('#categoryFilter');
  const current = sel.value;
  sel.replaceChildren(new Option('All categories', ''),
    ...state.meta.categories.map((c) => new Option(c.name, c.id)), new Option('Uncategorized', UNCATEGORIZED));
  sel.value = current === UNCATEGORIZED || state.meta.categories.some((c) => String(c.id) === current) ? current : '';
  state.filter.category = sel.value;
}

function renderLocationFilter() {
  const sel = $('#locationFilter');
  const current = sel.value;
  const locations = [...new Set(state.assets.map((a) => a.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.replaceChildren(new Option('All locations', ''), ...locations.map((l) => new Option(l, l)));
  sel.value = locations.includes(current) ? current : '';
  state.filter.location = sel.value;
}

function filteredAssets() {
  const { q, status, category, location, warranty } = state.filter;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.assets.filter((a) => {
    if (status && a.status !== status) return false;
    if (category === UNCATEGORIZED ? a.category_id != null : category && String(a.category_id) !== category) return false;
    if (location && a.location !== location) return false;
    if (warranty) {
      const d = daysUntil(a.warranty_end);
      if (d === null || d < 0 || d > 90 || CLOSED_STATUSES.includes(a.status)) return false;
    }
    return terms.every((t) => a._search.includes(t));
  });
  const { key, dir } = state.sort;
  const value = (a) => (key === 'name' ? assetTitle(a) : key === 'status' ? statusLabel(a.status) : a[key]) ?? '';
  return list.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (!va !== !vb) return va ? -1 : 1; // blanks last
    return dir * String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
  });
}

// Covers every status, including ones without a counter on the main page.
function renderStatusFilter() {
  const sel = $('#statusFilter');
  if (!sel.options.length) {
    sel.replaceChildren(new Option('All statuses', ''),
      ...Object.entries(state.meta.statuses).map(([key, label]) => new Option(label, key)));
  }
  sel.value = state.filter.status;
}

function renderStats() {
  renderStatusFilter();
  const counts = {};
  for (const a of state.assets) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const chip = (value, label, count, tone) => `
    <button type="button" class="stat ${tone ? `tone-${tone}` : ''}" data-status="${value}" aria-pressed="${state.filter.status === value}">
      <span class="stat-count">${count.toLocaleString()}</span><span class="stat-label">${esc(label)}</span>
    </button>`;
  $('#stats').innerHTML = chip('', 'All assets', state.assets.length, '') +
    Object.entries(state.meta.statuses).filter(([key]) => !HIDDEN_STAT_CHIPS.includes(key)).map(([key, label]) => chip(key, label, counts[key] ?? 0, STATUS_TONE[key])).join('');
}

function renderRegister() {
  renderStats();
  const list = filteredAssets();
  const shown = list.slice(0, state.limit);
  $('#rows').innerHTML = shown.map((a) => {
    const seen = a.last_seen_at ? fmtWhen(a.last_seen_at) : 'Never';
    return `<tr data-id="${a.id}" tabindex="0">
      <td data-label="Tag"><span class="tag-chip">${esc(a.tag)}</span></td>
      <td data-label="Asset" class="cell-asset"><div class="cell-main">${esc(assetTitle(a))}</div><div class="cell-sub">${esc(a.category ?? 'Uncategorized')}</div></td>
      <td data-label="User">${a.assignee ? esc(a.assignee) : '<span class="muted">—</span>'}</td>
      <td data-label="Location">${a.location ? esc(a.location) : '<span class="muted">—</span>'}</td>
      <td data-label="Serial" class="mono">${a.serial ? esc(a.serial) : '<span class="muted">—</span>'}</td>
      <td data-label="Last seen" class="${a.last_seen_at ? '' : 'muted'}">${esc(seen)}</td>
    </tr>`;
  }).join('');
  const total = state.assets.length;
  $('#resultCount').textContent = total
    ? `${list.length === total ? 'All' : 'Showing'} ${list.length.toLocaleString()}${list.length === total ? '' : ` of ${total.toLocaleString()}`} assets`
    : '';
  $('#moreBtn').hidden = list.length <= state.limit;
  $('#moreBtn').textContent = `Show ${Math.min(PAGE, list.length - state.limit)} more`;
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = total
      ? '<p><strong>No assets match these filters.</strong></p><button type="button" class="btn" id="clearFilters">Clear filters</button>'
      : `<p><strong>No assets yet.</strong></p><p class="muted">${can('tech')
        ? 'Scan a tag, add one with <b>New asset</b>, or bring in your spreadsheet with <b>Import CSV</b>.'
        : 'A technician needs to add assets before they show up here.'}</p>`;
  }
  $$('.grid th button').forEach((b) => {
    const active = b.dataset.sort === state.sort.key;
    b.closest('th').setAttribute('aria-sort', active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  $('#printListBtn').disabled = list.length === 0;
}

$('#stats').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  state.filter.status = btn.dataset.status === state.filter.status ? '' : btn.dataset.status;
  state.limit = PAGE;
  renderRegister();
});

$('#search').addEventListener('input', (e) => {
  state.filter.q = e.target.value;
  state.limit = PAGE;
  renderRegister();
});
$('#statusFilter').addEventListener('change', (e) => {
  state.filter.status = e.target.value;
  state.limit = PAGE;
  renderRegister();
});
$('#categoryFilter').addEventListener('change', (e) => { state.filter.category = e.target.value; renderRegister(); });
$('#locationFilter').addEventListener('change', (e) => { state.filter.location = e.target.value; renderRegister(); });
$('#warrantyChip').addEventListener('click', (e) => {
  state.filter.warranty = !state.filter.warranty;
  e.currentTarget.setAttribute('aria-pressed', String(state.filter.warranty));
  renderRegister();
});
$('#moreBtn').addEventListener('click', () => { state.limit += PAGE; renderRegister(); });

$('#empty').addEventListener('click', (e) => {
  if (e.target.id !== 'clearFilters') return;
  state.filter = { q: '', status: '', category: '', location: '', warranty: false };
  $('#search').value = '';
  $('#categoryFilter').value = '';
  $('#locationFilter').value = '';
  $('#warrantyChip').setAttribute('aria-pressed', 'false');
  renderRegister();
});

$('.grid thead').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
  renderRegister();
});

$('#rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openAsset(Number(row.dataset.id));
});
$('#rows').addEventListener('keydown', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openAsset(Number(row.dataset.id));
  }
});

// ---------------------------------------------------------------- Asset form

function buildAssetForm() {
  const { statuses, categories, kinds } = state.meta;
  const fields = formFields();
  const control = (f) => {
    const mono = f.mono ? ' mono' : '';
    switch (f.type) {
      case 'category':
        return `<select name="${f.key}"><option value="">Uncategorized</option>${categories
          .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`;
      case 'status':
        return `<select name="${f.key}">${Object.entries(statuses)
          .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`;
      case 'date':
        return `<input type="date" name="${f.key}">`;
      case 'number':
        return `<input type="number" name="${f.key}" min="0" step="0.01" inputmode="decimal">`;
      case 'textarea':
        return `<textarea name="${f.key}" rows="3" maxlength="${f.max}"></textarea>`;    }
    const list = f.key === 'location' ? ' list="locationList"' : f.key === 'assignee' ? ' list="assigneeList"' : '';
    const plain = f.mono || f.key === 'tag' ? ' autocapitalize="none" spellcheck="false"' : '';
    const input = `<input name="${f.key}" class="${mono}" maxlength="${f.max ?? 200}" autocomplete="off"${list}${plain}>`;
    if (f.key === 'tag') {
      return `<div class="input-row">${input}<button type="button" class="btn ghost small" data-next-tag title="Use the next free tag number">Next</button><button type="button" class="btn ghost small" data-scan-into="tag" aria-label="Scan the asset tag">Scan</button></div>`;
    }
    if (f.scan) {
      return `<div class="input-row">${input}<button type="button" class="btn ghost small" data-scan-into="${f.key}" aria-label="Scan ${esc(f.label)}">Scan</button></div>`;
    }
    return input;
  };
  $('#formFields').innerHTML = SECTIONS.map(([section, title]) => {
    const inSection = fields.filter((f) => f.section === section);
    return `<fieldset class="form-section">
      ${title ? `<legend>${title}</legend>` : ''}
      <div class="form-grid">${inSection.map((f) => `
        <label class="field ${f.type === 'textarea' ? 'span-2' : ''}" data-field="${f.key}" ${f.kinds ? `data-kinds="${f.kinds.join(' ')}"` : ''} ${f.categories ? `data-categories="${esc(f.categories.join('|'))}"` : ''}>
          <span>${esc(f.label)}</span>${control(f)}
        </label>`).join('')}
      </div>
    </fieldset>`;
  }).join('');
  $('#newCategoryKind').innerHTML = Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
}

function formFields() {
  return state.meta.fields.filter((f) => f.form !== false);
}

function formInput(key) {
  return $('#assetForm').elements.namedItem(key);
}

// Categories where "Hostname" doesn't fit, keyed by lowercase category name.
const NAME_LABELS = {
  'desk phone': 'Extension number',
  monitor: 'Name',
};

// Device-specific fields only show for matching categories, unless they
// already hold a value.
function applyKindVisibility() {
  const catId = formInput('category_id').value;
  const category = state.meta.categories.find((c) => String(c.id) === catId);
  const kind = category?.kind ?? 'other';
  const nameLabel = state.meta.fields.find((f) => f.key === 'name').label;
  $('#formFields [data-field="name"] > span').textContent =
    NAME_LABELS[category?.name.toLowerCase()] ?? nameLabel;
  $$('#formFields [data-kinds]').forEach((label) => {
    const show = label.dataset.kinds.split(' ').includes(kind) || formInput(label.dataset.field).value !== '';
    label.hidden = !show;
  });
  $$('#formFields [data-categories]').forEach((label) => {
    const show = label.dataset.categories.split('|').includes(category?.name.toLowerCase())
      || formInput(label.dataset.field).value !== '';
    label.hidden = !show;
  });
  // Hide a whole section when none of its fields apply (e.g. Network info for a monitor).
  $$('#formFields .form-section').forEach((section) => {
    section.hidden = !$$('.field', section).some((label) => !label.hidden);
  });
}

function fillAssetForm(asset) {
  for (const f of formFields()) {
    formInput(f.key).value = asset[f.key] ?? '';
  }
  applyKindVisibility();
  const readOnly = !can('tech');
  $$('#formFields input, #formFields select, #formFields textarea').forEach((el) => { el.disabled = readOnly; });
  $$('#formFields [data-next-tag], #formFields [data-scan-into]').forEach((el) => { el.hidden = readOnly; });
}

function readAssetForm() {
  const fields = {};
  for (const f of formFields()) {
    const value = formInput(f.key).value.trim();
    fields[f.key] = value === '' ? null : value;
  }
  return fields;
}

function showNotice(message, action) {
  const box = $('#sheetNotice');
  box.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: action.label });
    btn.addEventListener('click', action.fn);
    box.append(btn);
  }
  box.hidden = false;
}

function renderSheet() {
  const { asset, events } = state.current;
  const isNew = !asset;
  const tag = isNew ? (formInput('tag').value || 'New') : asset.tag;
  $('#sheetTag').textContent = tag;
  $('#sheetTag').hidden = isNew; // the "New asset" title says it already
  $('#sheetTitle').textContent = isNew ? 'New asset' : assetTitle(asset);
  const meta = [];
  if (!isNew) {
    meta.push(statusLabel(asset.status));
    if (asset.assignee) meta.push(asset.assignee);
    meta.push(asset.last_seen_at ? `Seen ${fmtWhen(asset.last_seen_at).toLowerCase()}${asset.last_seen_by_name ? ` by ${asset.last_seen_by_name}` : ''}` : 'Never scanned');
  }
  $('#sheetMeta').textContent = meta.join(' · ');
  $('#quickActions').hidden = isNew || !can('tech');
  if (!isNew) {
    const s = asset.status;
    const showFor = {
      checkout: s !== 'in_use' && !CLOSED_STATUSES.includes(s),
      checkin: s !== 'in_stock' && !CLOSED_STATUSES.includes(s),
      seen: true,
      repair: !['repair', ...CLOSED_STATUSES].includes(s),
      missing: !['lost', ...CLOSED_STATUSES].includes(s),
      found: s === 'lost',
      retire: !CLOSED_STATUSES.includes(s),
      dispose: s !== 'disposed',
    };
    $$('#quickActions [data-action]').forEach((b) => { b.hidden = !showFor[b.dataset.action]; });
  }
  $('#labelPanel').hidden = isNew;
  $('#historyPanel').hidden = isNew;
  $('#dangerPanel').hidden = isNew || !can('admin');
  $('#saveBtn').textContent = isNew ? 'Add asset' : 'Save changes';
  $('#history').innerHTML = (events ?? []).map((ev) => `
    <li>
      <div class="history-what">${esc(ev.detail ?? ev.action)}</div>
      <div class="history-when muted">${esc(ev.by ?? 'Someone')} · <time datetime="${esc(ev.at)}" title="${esc(new Date(ev.at).toLocaleString())}">${esc(fmtWhen(ev.at))}</time></div>
    </li>`).join('');
  if (!isNew) renderLabelPreview(asset);
}

async function openAsset(id, { quiet = false } = {}) {
  if (!quiet && !(await confirmDiscard())) return;
  try {
    const data = await api(`/assets/${id}`);
    state.current = data;
    state.dirty = false;
    fillAssetForm(data.asset);
    $('#sheetNotice').hidden = true;
    $('#assetError').textContent = '';
    renderSheet();
    // Existing assets open in the side panel, unless the full page is already showing.
    if (!$('#assetDialog').open) $('#assetDialog').classList.remove('page');
    openDialog($('#assetDialog'));
  } catch (err) {
    toast(err.message, { tone: 'crit' });
  }
}

// The New asset form is a full page with its own history entry (#new), so the
// browser's Back button returns to the list and a refresh keeps the form open.
let pushedNewPage = false;

function enterNewPage() {
  $('#assetDialog').classList.add('page');
  if (location.hash !== '#new') {
    history.pushState({ page: 'new' }, '', '#new');
    pushedNewPage = true;
  }
}

function leaveNewPage() {
  if (location.hash !== '#new') return;
  if (pushedNewPage) history.back();
  else history.replaceState(null, '', location.pathname + location.search);
  pushedNewPage = false;
}

window.addEventListener('popstate', () => {
  const dialog = $('#assetDialog');
  if (location.hash === '#new') {
    if (!dialog.open && state.me) openNew();
    return;
  }
  pushedNewPage = false;
  if (!dialog.open || !dialog.classList.contains('page')) return;
  if (state.dirty && !confirm('Discard your unsaved changes to this asset?')) {
    history.pushState({ page: 'new' }, '', '#new');
    pushedNewPage = true;
    return;
  }
  state.dirty = false;
  dialog.close();
});

async function openNew(prefill = {}) {
  if (!can('tech') || !(await confirmDiscard())) return;
  state.current = { asset: null, events: [] };
  state.dirty = false;
  fillAssetForm(prefill);
  $('#assetError').textContent = '';
  $('#sheetNotice').hidden = true;
  if (prefill.tag && prefill.scanned) {
    showNotice(`${prefill.tag} isn't in the register, so it's filled in as the asset tag. If it's a serial number, move it.`, {
      label: 'Use as serial number',
      fn: () => {
        formInput('serial').value = formInput('tag').value;
        formInput('tag').value = '';
        $('#sheetNotice').hidden = true;
        $('#sheetTag').textContent = 'New';
        formInput('tag').focus();
      },
    });
  }
  renderSheet();
  enterNewPage();
  openDialog($('#assetDialog'));
  // The tag is left blank on purpose: it's the barcode on the sticker, so it gets scanned in.
  formInput(prefill.tag ? 'category_id' : 'tag').focus();
}

async function fillNextTag() {
  try {
    const { tag } = await api('/assets/next-tag');
    if (!formInput('tag').value) {
      formInput('tag').value = tag;
      if (!state.current.asset) $('#sheetTag').textContent = tag;
    }
  } catch { /* leave blank */ }
}

async function confirmDiscard() {
  if (!state.dirty || !$('#assetDialog').open) return true;
  if (!confirm('Discard your unsaved changes to this asset?')) return false;
  state.dirty = false;
  return true;
}

$('#assetForm').addEventListener('input', (e) => {
  if (!e.target.closest('#formFields')) return;
  state.dirty = true;
  if (e.target.name === 'category_id') applyKindVisibility();
  if (e.target.name === 'tag' && !state.current.asset) $('#sheetTag').textContent = e.target.value || 'New';
});

// Enter in a text box would submit the form. Scanners press Enter after
// every code, so treat it as "next field" instead.
$('#assetForm').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  const fields = $$('#formFields input:not([type=hidden]), #formFields select, #formFields textarea')
    .filter((el) => !el.closest('[hidden]') && !el.disabled);
  fields[fields.indexOf(e.target) + 1]?.focus();
});

$('#assetForm').addEventListener('click', (e) => {
  if (e.target.closest('[data-next-tag]')) {
    formInput('tag').value = '';
    fillNextTag();
  }
  const scanBtn = e.target.closest('[data-scan-into]');
  if (scanBtn) {
    const key = scanBtn.dataset.scanInto;
    scanCode({
      title: `Scan the ${state.meta.fields.find((f) => f.key === key).label.toLowerCase()}`,
      onCode: (code) => {
        formInput(key).value = code;
        formInput(key).dispatchEvent(new Event('input', { bubbles: true }));
      },
    });
  }
});

$('#assetDialog').addEventListener('cancel', async (e) => {
  if (state.dirty) {
    e.preventDefault();
    if (await confirmDiscard()) $('#assetDialog').close();
  }
});
$('#assetDialog').addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]') && state.dirty) {
    e.stopPropagation();
    if (await confirmDiscard()) $('#assetDialog').close();
  }
}, true);
$('#assetDialog').addEventListener('close', () => {
  state.dirty = false;
  leaveNewPage();
  if (matchMedia('(pointer: fine)').matches) $('#scanInput').focus();
});

$('#assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!can('tech')) return;
  const fields = readAssetForm();
  if (!fields.tag) {
    $('#assetError').textContent = 'Give the asset a tag.';
    formInput('tag').focus();
    return;
  }
  const { asset } = state.current;
  $('#saveBtn').disabled = true;
  $('#assetError').textContent = '';
  try {
    const data = asset
      ? await api(`/assets/${asset.id}`, { method: 'PUT', body: { fields, expected_updated_at: asset.updated_at } })
      : await api('/assets', { method: 'POST', body: { fields } });
    state.current = data;
    state.dirty = false;
    fillAssetForm(data.asset);
    $('#sheetNotice').hidden = true;
    renderSheet();
    toast(asset ? `Saved ${data.asset.tag}` : `Added ${data.asset.tag}`, { tone: 'ok' });
    reloadAssets().catch(() => {});
  } catch (err) {
    $('#assetError').textContent = err.message;
    if (err.status === 409 && err.data?.asset) {
      showNotice('Someone else saved this asset after you opened it. Reload to see their changes, then make yours again.', {
        label: 'Reload',
        fn: () => { state.dirty = false; openAsset(asset.id); },
      });
    }
  } finally {
    $('#saveBtn').disabled = false;
  }
});

$('#deleteBtn').addEventListener('click', async () => {
  const { asset } = state.current;
  if (!confirm(`Delete ${asset.tag} and its history for good? This can't be undone.`)) return;
  try {
    await api(`/assets/${asset.id}`, { method: 'DELETE' });
    state.dirty = false;
    $('#assetDialog').close();
    toast(`Deleted ${asset.tag}`);
    reloadAssets().catch(() => {});
  } catch (err) {
    toast(err.message, { tone: 'crit' });
  }
});

// ---------------------------------------------------------------- Quick actions

let pendingAction = null;

// A copy keeps every field except the asset tag, which must be unique.
$('#copyBtn').addEventListener('click', async () => {
  const source = state.current.asset;
  const prefill = Object.fromEntries(formFields()
    .filter((f) => f.key !== 'tag')
    .map((f) => [f.key, source[f.key]]));
  await openNew(prefill);
  if (state.current.asset) return; // the user kept their unsaved edits instead
  state.dirty = true; // closing now would throw the copied details away
  showNotice(`Copied from ${source.tag}. Scan or enter the new asset tag.`);
});

$('#quickActions').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (state.dirty && !confirm('You have unsaved edits. Discard them and continue?')) return;
  state.dirty = false;
  const copy = ACTION_COPY[action];
  if (!copy) return runAction(action, {});
  pendingAction = action;
  const form = $('#actionForm');
  form.reset();
  $('#actionTitle').textContent = `${copy.title} ${state.current.asset.tag}`;
  $$('[data-for]', form).forEach((el) => { el.hidden = !copy.fields.includes(el.dataset.for); });
  $('#actionSubmit').textContent = copy.submit;
  $('#actionError').textContent = '';
  openDialog($('#actionDialog'));
  (copy.fields.includes('assignee') ? form.assignee : form.note).focus();
});

$('#actionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  if (pendingAction === 'checkout' && !body.assignee.trim()) {
    $('#actionError').textContent = 'Who is it going to?';
    return;
  }
  if (await runAction(pendingAction, body)) $('#actionDialog').close();
});

async function runAction(action, body) {
  const { asset } = state.current;
  try {
    const data = await api(`/assets/${asset.id}/action`, { method: 'POST', body: { action, ...body } });
    state.current = data;
    fillAssetForm(data.asset);
    renderSheet();
    toast(`${data.asset.tag}: ${data.events[0]?.detail ?? 'updated'}`, { tone: 'ok' });
    reloadAssets().catch(() => {});
    return true;
  } catch (err) {
    if ($('#actionDialog').open) $('#actionError').textContent = err.message;
    else toast(err.message, { tone: 'crit' });
    return false;
  }
}

// ---------------------------------------------------------------- Scanning

const camera = new CameraScanner($('#cameraDialog'));

function scanCode({ title, continuous = false, onCode }) {
  if (CameraScanner.supported()) {
    camera.open({ title, continuous, onCode });
    return;
  }
  // No live camera over plain HTTP: fall back to taking a photo.
  photoCallback = onCode;
  $('#photoInput').click();
}

let photoCallback = null;

$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const callback = photoCallback ?? handleCode;
  photoCallback = null;
  if (!file) return;
  toast('Reading barcode…', { timeout: 1500 });
  try {
    const code = await decodeImageFile(file);
    if (code) callback(code.trim());
    else toast('No barcode found. Fill the frame with the barcode, keep it sharp, and try again.', { tone: 'warn', timeout: 6000 });
  } catch (err) {
    toast(err.message || 'Could not read that photo', { tone: 'crit' });
  }
});

$('#cameraBtn').addEventListener('click', () => {
  if (!CameraScanner.supported()) {
    toast('Live camera needs HTTPS, so take a photo of the barcode instead.', { tone: 'warn', timeout: 6000 });
    $('#photoInput').click();
    return;
  }
  camera.open({
    title: state.audit.on ? `Auditing ${state.audit.location}` : 'Scan a barcode',
    continuous: state.audit.on,
    onCode: handleCode,
  });
});

$('#scanForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#scanInput');
  const code = input.value.trim();
  input.value = '';
  if (code) handleCode(code);
});

$('#newBtn').addEventListener('click', () => openNew());

// Barcode scanners that act as keyboards type the code and press Enter
// within a few milliseconds. Catch that anywhere on the page.
let wedgeBuffer = '';
let wedgeLast = 0;
document.addEventListener('keydown', (e) => {
  if (!state.me || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || $('dialog[open]')) {
    wedgeBuffer = '';
    return;
  }
  const now = performance.now();
  if (now - wedgeLast > 80) wedgeBuffer = '';
  wedgeLast = now;
  if (e.key === 'Enter') {
    if (wedgeBuffer.length >= 3) {
      e.preventDefault();
      handleCode(wedgeBuffer);
    }
    wedgeBuffer = '';
  } else if (e.key.length === 1) {
    wedgeBuffer += e.key;
  }
});

async function handleCode(raw) {
  const code = raw.trim();
  if (!code) return;
  if (state.audit.on) return auditScan(code);
  try {
    const { matches } = await api(`/assets/lookup?code=${encodeURIComponent(code)}`);
    if (matches.length === 1) return openAsset(matches[0].id);
    if (matches.length > 1) {
      $('#search').value = code;
      state.filter.q = code;
      renderRegister();
      toast(`${matches.length} assets share ${code}. Pick one from the list.`);
      return;
    }
    if (can('tech')) openNew({ tag: code, scanned: true });
    else toast(`Nothing in the register matches ${code}.`, { tone: 'warn' });
  } catch (err) {
    toast(err.message, { tone: 'crit' });
  }
}

// ---------------------------------------------------------------- Audit

function saveAudit() {
  store.set('audit', state.audit);
}

function restoreAudit() {
  // Audit mode is hidden from the main page, so never resume a saved audit:
  // scans would silently go to the audit instead of opening the asset.
  if ($('#auditBar').hidden) {
    state.audit = { on: false, location: '', scanned: {}, unknown: [] };
    return;
  }
  const saved = store.get('audit', null);
  if (saved?.location) state.audit = { on: false, scanned: {}, unknown: [], ...saved, on: !!saved.on && can('tech') };
  $('#auditToggle').checked = state.audit.on;
  $('#auditLocation').value = state.audit.location ?? '';
  renderAudit();
}

$('#auditToggle').addEventListener('change', (e) => {
  const location = $('#auditLocation').value.trim();
  if (e.target.checked && !location) {
    e.target.checked = false;
    toast('Type the room or location you are auditing first.', { tone: 'warn' });
    $('#auditLocation').focus();
    return;
  }
  if (e.target.checked) {
    const resume = state.audit.location && sameLocation(state.audit.location, location) && Object.keys(state.audit.scanned).length;
    state.audit = resume ? { ...state.audit, on: true } : { on: true, location, scanned: {}, unknown: [] };
    toast(`Auditing ${location}. Scan everything in the room.`);
  } else {
    state.audit.on = false;
  }
  saveAudit();
  renderAudit();
});

$('#auditLocation').addEventListener('change', (e) => {
  if (!state.audit.on) return;
  const location = e.target.value.trim();
  if (!location || sameLocation(location, state.audit.location)) return;
  state.audit = { on: true, location, scanned: {}, unknown: [] };
  saveAudit();
  renderAudit();
});

$('#auditEndBtn').addEventListener('click', () => {
  state.audit = { on: false, location: state.audit.location, scanned: {}, unknown: [] };
  $('#auditToggle').checked = false;
  saveAudit();
  renderAudit();
});

async function auditScan(code) {
  const { location } = state.audit;
  try {
    const { asset, moved, from } = await api('/audit/scan', { method: 'POST', body: { code, location } });
    state.audit.scanned[asset.id] = { tag: asset.tag, moved, from };
    saveAudit();
    toast(moved ? `${asset.tag} moved here from ${from || 'no location'}` : `${asset.tag} seen`, { tone: 'ok', timeout: 2000 });
    reloadAssets().catch(() => {});
  } catch (err) {
    if (err.status === 404) {
      if (!state.audit.unknown.includes(code)) state.audit.unknown.push(code);
      saveAudit();
      renderAudit();
      toast(`${code} isn't in the register`, {
        tone: 'warn',
        action: { label: 'Add it', fn: () => { camera.close(); openNew({ tag: code, location, scanned: true }); } },
      });
    } else {
      toast(err.message, { tone: 'crit' });
    }
  }
}

function auditExpected() {
  return state.assets.filter((a) => sameLocation(a.location, state.audit.location) && !CLOSED_STATUSES.includes(a.status));
}

function renderAudit() {
  const { on, location, scanned, unknown } = state.audit;
  $('#auditBar').classList.toggle('active', on);
  $('#auditBody').hidden = !on;
  $('#auditHint').hidden = on;
  if (!on) return;
  const expected = auditExpected();
  const remaining = expected.filter((a) => !scanned[a.id]);
  const scannedCount = Object.keys(scanned).length;
  $('#auditSummary').innerHTML = `<strong>${esc(location)}</strong>: ${scannedCount} scanned, ${remaining.length} of ${expected.length} expected not scanned yet${unknown.length ? `, ${unknown.length} unknown code${unknown.length === 1 ? '' : 's'}` : ''}.`;
  $('#auditRemaining').innerHTML = remaining.length
    ? remaining.slice(0, 200).map((a) => `<li><button type="button" class="link" data-open="${a.id}"><span class="tag-chip small">${esc(a.tag)}</span> ${esc(assetTitle(a))}</button></li>`).join('')
    : `<li class="muted">${expected.length ? 'Everything expected here has been scanned.' : 'Nothing is recorded at this location.'}</li>`;
  const scannedItems = Object.entries(scanned).reverse().slice(0, 200).map(([id, s]) =>
    `<li><button type="button" class="link" data-open="${id}"><span class="tag-chip small">${esc(s.tag)}</span>${s.moved ? ` moved from ${esc(s.from || 'no location')}` : ' seen'}</button></li>`);
  const unknownItems = unknown.map((code) =>
    `<li class="unknown"><span class="mono">${esc(code)}</span> not in register <button type="button" class="btn ghost small" data-add-code="${esc(code)}">Add</button></li>`);
  $('#auditScanned').innerHTML = [...unknownItems, ...scannedItems].join('') || '<li class="muted">Scan a tag to start.</li>';
  $('#auditMissingBtn').hidden = remaining.length === 0;
  $('#auditMissingBtn').textContent = `Mark ${remaining.length} unscanned as missing`;
}

$('#auditBody').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openAsset(Number(open.dataset.open));
  const add = e.target.closest('[data-add-code]');
  if (add) openNew({ tag: add.dataset.addCode, location: state.audit.location, scanned: true });
});

$('#auditMissingBtn').addEventListener('click', async () => {
  const remaining = auditExpected().filter((a) => !state.audit.scanned[a.id]);
  if (!remaining.length || !confirm(`Mark ${remaining.length} asset${remaining.length === 1 ? '' : 's'} recorded at ${state.audit.location} as missing?`)) return;
  let done = 0;
  for (const a of remaining) {
    try {
      await api(`/assets/${a.id}/action`, { method: 'POST', body: { action: 'missing', note: `Not found in audit of ${state.audit.location}` } });
      done++;
    } catch (err) {
      toast(`${a.tag}: ${err.message}`, { tone: 'crit' });
    }
  }
  toast(`Marked ${done} as missing`, { tone: 'ok' });
  reloadAssets().catch(() => {});
});

// ---------------------------------------------------------------- Labels

function labelSettings() {
  return { size: '2.25x1.25', showName: true, ...store.get('labelSettings', {}) };
}

function fitText(g, text, maxWidth) {
  if (g.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

// Draws one label at 300 dpi: organisation name, optional asset name,
// a Code 128 barcode and the tag in large type.
function renderLabel(asset, { size, showName }) {
  const [w, h, unit] = LABEL_SIZES[size] ?? LABEL_SIZES['2.25x1.25'];
  const toIn = unit === 'mm' ? 1 / 25.4 : 1;
  const W = Math.round(w * toIn * 300);
  const H = Math.round(h * toIn * 300);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  const pad = Math.round(Math.min(W, H) * 0.07);
  const inner = W - pad * 2;
  const headSize = Math.round(H * 0.1);
  g.font = `600 ${headSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillText(fitText(g, state.meta.orgName, inner), pad, pad);
  let y = pad + headSize * 1.2;
  const name = assetTitle(asset);
  if (showName && name) {
    const s = Math.round(H * 0.085);
    g.font = `${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillText(fitText(g, name, inner), pad, y);
    y += s * 1.25;
  }
  const tagSize = Math.round(H * 0.15);
  const barHeight = Math.max(30, H - y - pad - tagSize * 1.15);
  // Render once to count modules, then again at the widest whole-pixel bar width that fits.
  const bars = document.createElement('canvas');
  const opts = { format: 'CODE128', displayValue: false, margin: 0, height: barHeight, background: '#ffffff', lineColor: '#000000' };
  window.JsBarcode(bars, asset.tag, { ...opts, width: 1 });
  const moduleWidth = Math.max(1, Math.floor(inner / bars.width));
  window.JsBarcode(bars, asset.tag, { ...opts, width: moduleWidth });
  g.imageSmoothingEnabled = false;
  g.drawImage(bars, Math.round((W - bars.width) / 2), Math.round(y));
  g.font = `700 ${tagSize}px ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace`;
  g.textAlign = 'center';
  g.fillText(fitText(g, asset.tag, inner), W / 2, y + barHeight + tagSize * 0.12);
  return canvas;
}

function renderLabelPreview(asset) {
  if (!window.JsBarcode) {
    setTimeout(() => renderLabelPreview(asset), 200);
    return;
  }
  try {
    $('#labelPreview').src = renderLabel(asset, labelSettings()).toDataURL('image/png');
  } catch {
    $('#labelPreview').removeAttribute('src');
  }
}

function openLabelDialog(assets) {
  state.labelTargets = assets;
  const form = $('#labelForm');
  const settings = labelSettings();
  form.size.value = settings.size;
  form.showName.checked = settings.showName;
  $('#labelCount').textContent = assets.length === 1
    ? `Label for ${assets[0].tag}.`
    : `${assets.length.toLocaleString()} labels, one for each asset in the current list.`;
  openDialog($('#labelDialog'));
}

$('#printOneBtn').addEventListener('click', () => openLabelDialog([state.current.asset]));
$('#printListBtn').addEventListener('click', () => {
  const list = filteredAssets();
  if (list.length > 200 && !confirm(`Print ${list.length} labels? Filter the list first to print fewer.`)) return;
  openLabelDialog(list);
});

$('#downloadLabelBtn').addEventListener('click', () => {
  const { asset } = state.current;
  renderLabel(asset, labelSettings()).toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${asset.tag.replace(/[^\w.-]+/g, '_')}-label.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});

$('#labelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = { size: e.target.size.value, showName: e.target.showName.checked };
  store.set('labelSettings', settings);
  $('#labelDialog').close();
  if (state.current?.asset && $('#assetDialog').open) renderLabelPreview(state.current.asset);
  await printLabels(state.labelTargets, settings);
});

async function printLabels(assets, settings) {
  const [w, h, unit] = LABEL_SIZES[settings.size];
  const area = $('#printArea');
  const failed = [];
  const imgs = [];
  for (const asset of assets) {
    let src;
    try {
      src = renderLabel(asset, settings).toDataURL('image/png');
    } catch {
      failed.push(asset.tag); // Code 128 can't encode some characters
      continue;
    }
    const img = new Image();
    img.className = 'print-label';
    img.style.width = `${w}${unit}`;
    img.style.height = `${h}${unit}`;
    img.alt = asset.tag;
    img.src = src;
    imgs.push(img);
  }
  if (failed.length) toast(`Couldn't make a barcode for ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`, { tone: 'warn' });
  if (!imgs.length) return;
  area.replaceChildren(...imgs);
  let pageStyle = $('#pageStyle');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'pageStyle';
    document.head.append(pageStyle);
  }
  pageStyle.textContent = `@page { size: ${w}${unit} ${h}${unit}; margin: 0; }`;
  await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
  document.body.classList.add('printing-labels');
  const cleanup = () => {
    document.body.classList.remove('printing-labels');
    area.replaceChildren();
    pageStyle.textContent = '';
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
}

// ---------------------------------------------------------------- CSV import

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast('That file is over 20 MB. Split it into smaller files.', { tone: 'crit' });
    return;
  }
  toast(`Importing ${file.name}…`, { timeout: 2000 });
  try {
    const result = await api('/assets/import', { method: 'POST', body: { csv: await file.text() } });
    const parts = [
      `<p><strong>${result.created.toLocaleString()}</strong> added, <strong>${result.updated.toLocaleString()}</strong> updated, ${result.unchanged.toLocaleString()} already up to date.</p>`,
    ];
    if (result.newCategories.length) parts.push(`<p>New categories: ${result.newCategories.map(esc).join(', ')}. Check their device type under Admin.</p>`);
    if (result.errors.length) {
      parts.push(`<p>${result.errors.length} row${result.errors.length === 1 ? ' was' : 's were'} skipped:</p><ul class="error-list">${result.errors
        .map((er) => `<li>Row ${er.line}: ${esc(er.message)}</li>`).join('')}</ul>`);
    }
    showInfo('Import finished', parts.join(''));
    await Promise.all([reloadAssets(), result.newCategories.length ? reloadMeta() : null]);
  } catch (err) {
    showInfo('Import failed', `<p>${esc(err.message)}</p>`);
  }
});

function showInfo(title, html) {
  $('#infoTitle').textContent = title;
  $('#infoBody').innerHTML = html;
  openDialog($('#infoDialog'));
}

// ---------------------------------------------------------------- Account

$('#accountBtn').addEventListener('click', () => {
  $('#passwordForm').reset();
  $('#passwordError').textContent = '';
  $('#accountWho').textContent = `Signed in as ${state.me.username} (${state.meta.roles[state.me.role]})`;
  openDialog($('#accountDialog'));
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api('/me/password', { method: 'POST', body });
    $('#accountDialog').close();
    toast('Password changed. Other devices have been signed out.', { tone: 'ok' });
  } catch (err) {
    $('#passwordError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* signing out anyway */ }
  signedOut();
});

// ---------------------------------------------------------------- Admin

$('#adminBtn').addEventListener('click', () => {
  openDialog($('#adminDialog'));
  loadUsers();
  renderCategories();
});

$('#adminDialog .tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (!tab) return;
  $$('#adminDialog [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('#adminDialog [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
});

async function loadUsers() {
  try {
    const { users } = await api('/users');
    const roleOptions = (role) => Object.entries(state.meta.roles)
      .map(([k, v]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${esc(v)}</option>`).join('');
    $('#userRows').innerHTML = users.map((u) => `
      <tr data-user="${u.id}" class="${u.active ? '' : 'inactive'}">
        <td data-label="Name">${esc(u.name)}${u.id === state.me.id ? ' <span class="muted">(you)</span>' : ''}</td>
        <td data-label="Username" class="mono">${esc(u.username)}</td>
        <td data-label="Role"><select data-user-role aria-label="Role for ${esc(u.name)}">${roleOptions(u.role)}</select></td>
        <td data-label="Active"><input type="checkbox" data-user-active ${u.active ? 'checked' : ''} aria-label="${esc(u.name)} can sign in"></td>
        <td><button type="button" class="btn ghost small" data-user-reset>Reset password</button></td>
      </tr>`).join('');
  } catch (err) {
    toast(err.message, { tone: 'crit' });
  }
}

async function patchUser(id, body, success) {
  try {
    await api(`/users/${id}`, { method: 'PATCH', body });
    toast(success, { tone: 'ok' });
  } catch (err) {
    toast(err.message, { tone: 'crit' });
  }
  loadUsers();
}

$('#userRows').addEventListener('change', (e) => {
  const id = Number(e.target.closest('[data-user]')?.dataset.user);
  if (e.target.matches('[data-user-role]')) patchUser(id, { role: e.target.value }, 'Role updated');
  if (e.target.matches('[data-user-active]')) {
    patchUser(id, { active: e.target.checked }, e.target.checked ? 'Account turned on' : 'Account turned off and signed out');
  }
});

$('#userRows').addEventListener('click', (e) => {
  if (!e.target.matches('[data-user-reset]')) return;
  const id = Number(e.target.closest('[data-user]').dataset.user);
  const password = prompt('New temporary password (at least 10 characters). Give it to them in person or by phone.');
  if (password) patchUser(id, { password }, 'Password reset. They have been signed out everywhere.');
});

$('#addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    $('#addUserError').textContent = '';
    toast('Team member added', { tone: 'ok' });
    loadUsers();
  } catch (err) {
    $('#addUserError').textContent = err.message;
  }
});

function renderCategories() {
  const kindOptions = (kind) => Object.entries(state.meta.kinds)
    .map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('#categoryRows').innerHTML = state.meta.categories.map((c) => `
    <tr data-category="${c.id}">
      <td data-label="Category"><input value="${esc(c.name)}" data-category-name aria-label="Category name" maxlength="80"></td>
      <td data-label="Device type"><select data-category-kind aria-label="Device type for ${esc(c.name)}">${kindOptions(c.kind)}</select></td>
      <td data-label="Assets">${c.count}</td>
      <td>${c.count ? '' : '<button type="button" class="btn ghost small" data-category-delete>Delete</button>'}</td>
    </tr>`).join('');
}

async function categoryRequest(path, options, success) {
  try {
    await api(path, options);
    toast(success, { tone: 'ok' });
    await reloadMeta();
    await reloadAssets();
    return true;
  } catch (err) {
    toast(err.message, { tone: 'crit' });
    return false;
  } finally {
    renderCategories();
  }
}

$('#categoryRows').addEventListener('change', (e) => {
  const id = e.target.closest('[data-category]')?.dataset.category;
  if (e.target.matches('[data-category-name]')) categoryRequest(`/categories/${id}`, { method: 'PATCH', body: { name: e.target.value } }, 'Category renamed');
  if (e.target.matches('[data-category-kind]')) categoryRequest(`/categories/${id}`, { method: 'PATCH', body: { kind: e.target.value } }, 'Device type updated');
});

$('#categoryRows').addEventListener('click', (e) => {
  if (!e.target.matches('[data-category-delete]')) return;
  const id = e.target.closest('[data-category]').dataset.category;
  categoryRequest(`/categories/${id}`, { method: 'DELETE' }, 'Category deleted');
});

$('#addCategoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/categories', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    $('#addCategoryError').textContent = '';
    toast('Category added', { tone: 'ok' });
    await reloadMeta();
    renderCategories();
  } catch (err) {
    $('#addCategoryError').textContent = err.message;
  }
});

boot();
