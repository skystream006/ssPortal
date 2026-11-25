const byId = (id) => document.getElementById(id);
const formatDate = (value) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const number = (value) => Number(value).toLocaleString();
const icons = () => window.lucide.createIcons({ attrs: { width: 18, height: 18, 'stroke-width': 1.7 } });
const state = { page: 1, pageSize: 25, total: 0, detail: null, generation: 0, loading: false, confirmation: null, user: null, schema: null, editing: null, devicePage: 1, deviceTotal: 0, deviceGeneration: 0 };
const previousFocus = new WeakMap();

async function api(path, options = {}) {
  const response = await fetch(`/ssacademy/api${path}`, {
    ...options, credentials: 'same-origin', cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(12_000),
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (response.status === 401) {
    location.assign('/?returnTo=%2Fssacademy%2F');
    throw new Error('Your portal session has ended.');
  }
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'The request failed.');
  return body;
}

function notice(message, error = false) {
  const target = byId('notice');
  target.textContent = message;
  target.hidden = !message;
  target.classList.toggle('error', error);
  target.setAttribute('role', error ? 'alert' : 'status');
}

function dialogError(dialog, error) {
  const target = dialog.querySelector('.dialog-error');
  if (!target) return;
  target.textContent = error ? error.message ?? String(error) : '';
  target.hidden = !error;
}

function openDialog(dialog) {
  previousFocus.set(dialog, document.activeElement);
  dialogError(dialog, null);
  dialog.showModal();
}

function setBusy(dialog, busy) {
  dialog.dataset.busy = String(busy);
  for (const control of dialog.querySelectorAll('button, input, textarea, select')) control.disabled = busy;
}

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', (event) => {
    if (dialog.dataset.busy === 'true') event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    previousFocus.get(dialog)?.focus();
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
    if (dialog.dataset.busy === 'true') return;
    dialog.close();
  });
}

async function loadImports() {
  const generation = ++state.generation;
  state.loading = true;
  byId('refresh-imports').disabled = true;
  byId('imports-body').setAttribute('aria-busy', 'true');
  const allUsers = state.user?.role === 'admin' && byId('all-users').checked;
  const query = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize), search: byId('search-imports').value.trim(), source: byId('source-filter').value, scope: allUsers ? 'all' : 'mine' });
  try {
    const result = await api(`/imports?${query}`);
    if (generation !== state.generation) return;
    state.total = result.total;
    const body = byId('imports-body');
    body.replaceChildren();
    for (const record of result.imports) {
      const row = byId('import-row').content.firstElementChild.cloneNode(true);
      row.querySelector('[data-source]').textContent = record.source;
      row.querySelector('[data-owner]').textContent = record.ownerId === state.user.id ? 'You' : record.ownerName;
      row.querySelector('[data-owner]').hidden = !allUsers;
      row.querySelector('[data-date]').textContent = formatDate(record.importedAt);
      row.querySelector('[data-whole]').textContent = number(record.whole);
      row.querySelector('[data-fragments]').textContent = number(record.fragments);
      row.querySelector('[data-animations]').textContent = number(record.animationCount);
      for (const button of row.querySelectorAll('[data-details]')) {
        button.setAttribute('aria-label', `View ${record.source}`);
        button.title = `View ${record.source}`;
        button.addEventListener('click', () => void showDetails(record.id));
      }
      body.append(row);
    }
    const selected = byId('source-filter').value;
    byId('source-filter').replaceChildren(new Option('All sources', ''), ...result.sources.map((source) => new Option(source, source)));
    byId('source-filter').value = selected;
    if (selected && !result.sources.includes(selected)) { state.page = 1; byId('source-filter').value = ''; return loadImports(); }
    byId('imports-empty').hidden = result.total > 0;
    byId('imports-empty').querySelector('h2').textContent = byId('search-imports').value || selected ? 'No matching exports' : 'No collection exports';
    byId('import-count').textContent = `${number(result.total)} stored ${result.total === 1 ? 'snapshot' : 'snapshots'}`;
    const first = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
    const last = Math.min(result.page * result.pageSize, result.total);
    byId('page-summary').textContent = `${first}-${last} of ${number(result.total)}`;
    byId('previous-page').disabled = state.page <= 1;
    byId('next-page').disabled = state.page * state.pageSize >= result.total;
    icons();
  } catch (error) { if (generation === state.generation) notice(error.message, true); }
  finally {
    if (generation === state.generation) { state.loading = false; byId('refresh-imports').disabled = false; byId('imports-body').setAttribute('aria-busy', 'false'); }
  }
}

async function showDetails(id) {
  try {
    const { import: record } = await api(`/imports/${encodeURIComponent(id)}`);
    renderDetails(record);
    openDialog(byId('detail-dialog'));
  } catch (error) { notice(error.message, true); }
}

function renderDetails(record) {
  state.detail = record;
  byId('detail-title').textContent = record.source;
  byId('detail-owner').textContent = record.ownerId === state.user.id ? 'You' : record.ownerName;
  byId('detail-revision').textContent = record.revision;
  byId('detail-edited').textContent = record.updatedAt ? formatDate(record.updatedAt) : 'Not edited';
  byId('detail-date').textContent = formatDate(record.importedAt);
  byId('detail-schema').textContent = `${record.format} / v${record.version}`;
  byId('detail-checksum').textContent = record.sha256;
  byId('detail-original-checksum').textContent = record.importedSha256;
  byId('original-checksum-row').hidden = record.sha256 === record.importedSha256;
  byId('reward-count').textContent = record.rewards.length;
  byId('rewards-body').replaceChildren();
  for (const reward of record.rewards) {
    const row = document.createElement('tr');
    for (const value of [reward.label, reward.tier, reward.whole, reward.fragments]) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
    }
    byId('rewards-body').append(row);
  }
  byId('search-animations').value = '';
  byId('edit-values').hidden = state.user.role !== 'admin';
  byId('delete-import').hidden = record.ownerId !== state.user.id;
  byId('edit-saved').hidden = true;
  setEditMode(false);
  renderAnimations();
}

function setEditMode(editing) {
  byId('edit-form').hidden = !editing;
  byId('detail-read-view').hidden = editing;
  byId('detail-read-actions').hidden = editing;
  if (!editing) state.editing = null;
  dialogError(byId('detail-dialog'), null);
}

byId('edit-values').addEventListener('click', async () => {
  const dialog = byId('detail-dialog');
  if (state.user?.role !== 'admin' || dialog.dataset.busy === 'true') return;
  setBusy(dialog, true);
  try {
    state.schema ??= await api('/schema');
    state.editing = state.detail;
    const balances = new Map(state.detail.rewards.map((reward) => [reward.id, reward]));
    byId('edit-rewards-body').replaceChildren();
    for (const reward of state.schema.rewards) {
      const row = document.createElement('tr');
      const label = document.createElement('td'); label.textContent = reward.label;
      const tier = document.createElement('td'); tier.textContent = reward.tier;
      row.append(label, tier);
      for (const field of ['whole', 'fragments']) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number'; input.required = true; input.min = '0'; input.step = '1';
        input.max = String(field === 'whole' ? state.schema.maxWhole : 2);
        input.value = String(balances.get(reward.id)?.[field] ?? 0);
        input.dataset.reward = reward.id; input.dataset.field = field;
        input.setAttribute('aria-label', `${reward.label} ${field}`);
        cell.append(input); row.append(cell);
      }
      byId('edit-rewards-body').append(row);
    }
    byId('edit-animations').value = state.detail.animations.join('\n');
    byId('edit-saved').hidden = true;
    setEditMode(true);
  } catch (error) { dialogError(dialog, error); }
  finally { setBusy(dialog, false); }
});
byId('cancel-edit').addEventListener('click', () => setEditMode(false));
byId('edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = byId('detail-dialog');
  if (!state.editing || dialog.dataset.busy === 'true') return;
  setBusy(dialog, true); dialogError(dialog, null);
  const original = state.editing;
  try {
    const rewards = {};
    const included = new Set(original.rewards.map((reward) => reward.id));
    for (const reward of state.schema.rewards) {
      const values = {};
      for (const input of byId('edit-rewards-body').querySelectorAll(`input[data-reward="${reward.id}"]`)) values[input.dataset.field] = Number(input.value);
      if (included.has(reward.id) || values.whole !== 0 || values.fragments !== 0) rewards[reward.id] = values;
    }
    const data = { format: original.format, version: original.version, rewards, pokemons: byId('edit-animations').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) };
    const result = await api(`/imports/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: original.revision, data }) });
    renderDetails(result.import);
    byId('edit-saved').textContent = 'Collection values saved.';
    byId('edit-saved').hidden = false;
    await loadImports();
  } catch (error) { dialogError(dialog, error); }
  finally { setBusy(dialog, false); }
});

function renderAnimations() {
  const query = byId('search-animations').value.trim().toLowerCase();
  const records = (state.detail?.animations ?? []).filter((id) => id.toLowerCase().replaceAll('_', ' ').includes(query.replaceAll('_', ' ')));
  byId('animation-count').textContent = `${records.length} / ${state.detail?.animations.length ?? 0}`;
  byId('animations-list').replaceChildren();
  for (const id of records) {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.textContent = id.toLowerCase().split('_').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
    const code = document.createElement('code'); code.textContent = id;
    row.append(name, code); byId('animations-list').append(row);
  }
  if (!records.length) { const empty = document.createElement('li'); empty.textContent = 'No matching animations'; byId('animations-list').append(empty); }
}

async function loadTokens() {
  if (state.user?.role !== 'admin') return;
  const generation = ++state.deviceGeneration;
  byId('refresh-tokens').disabled = true;
  try {
    const query = new URLSearchParams({ status: byId('device-status').value, search: byId('search-devices').value.trim(), page: String(state.devicePage), pageSize: '50' });
    const result = await api(`/tokens?${query}`);
    if (generation !== state.deviceGeneration) return;
    state.deviceTotal = result.total;
    if (result.total > 0 && state.devicePage > Math.ceil(result.total / 50)) { state.devicePage = Math.ceil(result.total / 50); return loadTokens(); }
    byId('tokens-body').replaceChildren();
    for (const device of result.devices) {
      const row = byId('token-row').content.firstElementChild.cloneNode(true);
      row.querySelector('[data-username]').textContent = device.username;
      row.querySelector('[data-fingerprint]').textContent = device.fingerprint;
      row.querySelector('[data-account]').textContent = device.accountStatus === 'approved' ? device.accountName : device.accountStatus ? `Account ${device.accountStatus}` : 'No portal account';
      row.querySelector('[data-status]').textContent = device.status;
      row.querySelector('[data-status]').classList.add(`device-${device.status}`);
      const active = device.status === 'approved';
      const access = active ? (device.syncApproved ? 'Uploads and owner sync' : 'Uploads only') : '';
      row.querySelector('[data-access]').textContent = [access, device.syncRequested && !device.syncApproved ? 'Owner sync requested' : ''].filter(Boolean).join(' · ');
      row.querySelector('[data-created]').textContent = formatDate(device.createdAt);
      row.querySelector('[data-expires]').textContent = device.expiresAt ? formatDate(device.expiresAt) : 'Not approved';
      row.querySelector('[data-used]').textContent = device.lastUsedAt ? formatDate(device.lastUsedAt) : 'Never';
      const approve = row.querySelector('[data-approve]');
      approve.hidden = active && !device.syncRequested;
      approve.disabled = device.accountStatus !== 'approved';
      approve.setAttribute('aria-label', `${active ? 'Change access for' : 'Approve'} ${device.username} (${device.fingerprint})`);
      approve.title = approve.disabled ? 'The portal account must be approved first' : active ? 'Change app access' : 'Approve app';
      approve.addEventListener('click', () => confirm(active ? 'Change app access?' : 'Approve app?', `${device.username} / ${device.fingerprint}`, active ? 'Save access' : 'Approve app', async () => {
        const syncApproved = device.syncRequested === true && byId('grant-sync').checked;
        await api(`/tokens/${encodeURIComponent(device.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', syncApproved }) });
        await loadTokens(); notice(syncApproved ? 'App approved for uploads and owner sync.' : 'App approved for uploads only.');
      }, false, device.syncRequested ? device.syncApproved : undefined));
      const revoke = row.querySelector('[data-revoke]');
      revoke.hidden = device.status === 'revoked';
      revoke.title = `Revoke ${device.username} (${device.fingerprint})`;
      revoke.setAttribute('aria-label', revoke.title);
      revoke.addEventListener('click', () => confirm('Revoke app access?', `${device.username} / ${device.fingerprint}`, 'Revoke app', async () => {
        await api(`/tokens/${encodeURIComponent(device.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) });
        await loadTokens(); notice('App access revoked.');
      }));
      const remove = row.querySelector('[data-delete]');
      remove.title = `Delete ${device.username} (${device.fingerprint})`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => confirm('Delete app registration?', `${device.username} / ${device.fingerprint}`, 'Delete registration', async () => {
        await api(`/tokens/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
        await loadTokens(); notice('App registration deleted.');
      }));
      byId('tokens-body').append(row);
    }
    byId('tokens-empty').hidden = result.total > 0;
    byId('tokens-empty').querySelector('h2').textContent = byId('device-status').value || byId('search-devices').value.trim() ? 'No matching apps' : 'No app registrations';
    byId('device-count').textContent = `${number(result.total)} registered ${result.total === 1 ? 'app' : 'apps'}`;
    byId('device-page-summary').textContent = `${result.total ? (state.devicePage - 1) * 50 + 1 : 0}-${Math.min(state.devicePage * 50, result.total)} of ${number(result.total)}`;
    byId('previous-device-page').disabled = state.devicePage <= 1;
    byId('next-device-page').disabled = state.devicePage * 50 >= result.total;
    icons();
  } catch (error) { if (generation === state.deviceGeneration) notice(error.message, true); }
  finally { if (generation === state.deviceGeneration) byId('refresh-tokens').disabled = false; }
}

function confirm(title, message, label, action, destructive = true, syncChoice) {
  state.confirmation = action;
  byId('confirm-title').textContent = title;
  byId('confirm-message').textContent = message;
  byId('sync-choice').hidden = syncChoice === undefined;
  byId('grant-sync').checked = syncChoice === true;
  const button = byId('confirm-action');
  button.querySelector('span').textContent = label;
  button.className = destructive ? 'danger-button' : 'primary-button';
  const icon = document.createElement('i');
  icon.dataset.lucide = destructive ? 'trash-2' : 'check';
  button.querySelector('svg, [data-lucide]')?.replaceWith(icon);
  icons();
  openDialog(byId('confirm-dialog'));
}

byId('confirm-action').addEventListener('click', async () => {
  const dialog = byId('confirm-dialog');
  if (dialog.dataset.busy === 'true') return;
  setBusy(dialog, true);
  try { await state.confirmation(); dialog.close(); }
  catch (error) { dialogError(dialog, error); }
  finally { setBusy(dialog, false); }
});

byId('open-import').addEventListener('click', () => { byId('import-form').reset(); openDialog(byId('import-dialog')); });
byId('choose-json').addEventListener('click', () => byId('json-file').click());
byId('json-file').addEventListener('change', async () => {
  const file = byId('json-file').files[0];
  if (!file) return;
  try {
    if (file.size > 256 * 1024) throw new Error('Export data exceeds 256 KiB.');
    const text = (await file.text()).replace(/^\uFEFF/, '');
    JSON.parse(text);
    byId('import-data').value = text;
    dialogError(byId('import-dialog'), null);
  } catch (error) { dialogError(byId('import-dialog'), error); }
});
byId('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = byId('import-dialog');
  if (dialog.dataset.busy === 'true') return;
  setBusy(dialog, true); dialogError(dialog, null);
  try {
    const text = byId('import-data').value.replace(/^\uFEFF/, '');
    if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error('Export data exceeds 256 KiB.');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Enter a valid ssAcademy collections JSON object.'); }
    const result = await api('/imports', { method: 'POST', body: JSON.stringify({ source: byId('import-source').value.trim(), data }) });
    state.page = 1; byId('search-imports').value = ''; byId('source-filter').value = '';
    dialog.close(); await loadImports();
    notice(result.duplicate ? 'This snapshot is already stored. No duplicate records were added.' : 'Collection data imported.');
  } catch (error) { dialogError(dialog, error); }
  finally { setBusy(dialog, false); }
});
byId('delete-import').addEventListener('click', () => {
  const record = state.detail;
  confirm('Delete imported data?', record.source, 'Delete import', async () => {
    await api(`/imports/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    byId('detail-dialog').close(); state.page = 1; await loadImports(); notice('Import and its database records deleted.');
  });
});
let deviceSearchTimer;
byId('search-devices').addEventListener('input', () => { clearTimeout(deviceSearchTimer); deviceSearchTimer = setTimeout(() => { state.devicePage = 1; void loadTokens(); }, 200); });
byId('device-status').addEventListener('change', () => { state.devicePage = 1; void loadTokens(); });
byId('refresh-tokens').addEventListener('click', () => { notice(''); void loadTokens(); });
byId('previous-device-page').addEventListener('click', () => { if (state.devicePage > 1) { state.devicePage--; void loadTokens(); } });
byId('next-device-page').addEventListener('click', () => { if (state.devicePage * 50 < state.deviceTotal) { state.devicePage++; void loadTokens(); } });
let searchTimer;
byId('search-imports').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 1; void loadImports(); }, 200); });
byId('source-filter').addEventListener('change', () => { state.page = 1; void loadImports(); });
byId('all-users').addEventListener('change', () => { state.page = 1; byId('source-filter').value = ''; void loadImports(); });
byId('page-size').addEventListener('change', () => { state.pageSize = Number(byId('page-size').value); state.page = 1; void loadImports(); });
byId('previous-page').addEventListener('click', () => { if (state.page > 1) { state.page--; void loadImports(); } });
byId('next-page').addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page++; void loadImports(); } });
byId('refresh-imports').addEventListener('click', () => { notice(''); void loadImports(); });
byId('search-animations').addEventListener('input', renderAnimations);

function changeView() {
  const requestedTokens = location.hash === '#tokens';
  const tokens = requestedTokens && state.user?.role === 'admin';
  byId('collections-view').hidden = tokens; byId('tokens-view').hidden = !tokens;
  byId('section-label').textContent = tokens ? 'APP APPROVALS' : 'COLLECTIONS';
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === (tokens ? 'tokens' : 'collections')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  notice(requestedTokens && !tokens ? 'Administrator access is required for app approvals.' : '', requestedTokens && !tokens);
  if (tokens) void loadTokens(); else void loadImports();
}
window.addEventListener('hashchange', changeView);
icons();
try { const profile = await api('/me'); state.user = profile.user; byId('user-name').textContent = profile.user.name; byId('all-users-control').hidden = profile.user.role !== 'admin'; byId('tokens-link').hidden = profile.user.role !== 'admin'; changeView(); }
catch (error) { notice(error.message, true); }