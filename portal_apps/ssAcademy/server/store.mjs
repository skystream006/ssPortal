import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inputError, REWARDS, validateExport, validateImport } from './exports.mjs';

export function createStore({ path = ':memory:', now = Date.now } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL,
      format TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(owner_id, source, sha256)
    );
    CREATE INDEX IF NOT EXISTS imports_owner_created ON imports(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS reward_balances (
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      reward_type TEXT NOT NULL, whole INTEGER NOT NULL CHECK(whole BETWEEN 0 AND 715827881),
      fragments INTEGER NOT NULL CHECK(fragments BETWEEN 0 AND 2), PRIMARY KEY(import_id, reward_type)
    );
    CREATE TABLE IF NOT EXISTS collected_animations (
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      animation_id TEXT NOT NULL, PRIMARY KEY(import_id, animation_id)
    );
    CREATE TABLE IF NOT EXISTS import_settings (
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
      PRIMARY KEY(import_id, setting_key)
    );
    CREATE TABLE IF NOT EXISTS import_edits (
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, editor_id TEXT NOT NULL, edited_at INTEGER NOT NULL,
      previous_sha256 TEXT NOT NULL, current_sha256 TEXT NOT NULL,
      PRIMARY KEY(import_id, revision)
    );
  `);

  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('imports')").all().map((column) => column.name));
  for (const [name, type] of Object.entries({ current_sha256: 'TEXT', revision: 'INTEGER NOT NULL DEFAULT 1', updated_at: 'INTEGER', updated_by: 'TEXT', owner_name: 'TEXT', has_settings: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) database.exec(`ALTER TABLE imports ADD COLUMN ${name} ${type}`);
  }
  database.exec('UPDATE imports SET current_sha256 = sha256 WHERE current_sha256 IS NULL');

  const summary = `SELECT id, owner_id AS ownerId, coalesce(owner_name, owner_id) AS ownerName,
    source, format, version, current_sha256 AS sha256, sha256 AS importedSha256,
    revision, updated_at AS updatedAt, updated_by AS updatedBy, created_at AS importedAt,
    (SELECT count(*) FROM reward_balances WHERE import_id = imports.id) AS rewardCount,
    (SELECT coalesce(sum(whole), 0) FROM reward_balances WHERE import_id = imports.id) AS whole,
    (SELECT coalesce(sum(fragments), 0) FROM reward_balances WHERE import_id = imports.id) AS fragments,
    (SELECT count(*) FROM collected_animations WHERE import_id = imports.id) AS animationCount FROM imports`;

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }

  function getImport(ownerId, id, allowAll = false) {
    const record = database.prepare(`${summary} WHERE (owner_id = ? OR ? = 1) AND id = ?`).get(ownerId, allowAll ? 1 : 0, id);
    if (!record) throw inputError('Import not found.', 404);
    const rewards = database.prepare('SELECT reward_type AS id, whole, fragments FROM reward_balances WHERE import_id = ? ORDER BY reward_type').all(id);
    const animations = database.prepare('SELECT animation_id FROM collected_animations WHERE import_id = ? ORDER BY animation_id').all(id).map((row) => row.animation_id);
    const edits = database.prepare('SELECT revision, editor_id AS editorId, edited_at AS editedAt, previous_sha256 AS previousSha256, current_sha256 AS sha256 FROM import_edits WHERE import_id = ? ORDER BY revision DESC').all(id);
    const hasSettings = database.prepare('SELECT has_settings FROM imports WHERE id = ?').get(id).has_settings;
    const settings = hasSettings ? Object.fromEntries(database.prepare('SELECT setting_key, setting_value FROM import_settings WHERE import_id = ? ORDER BY setting_key')
      .all(id).map((row) => [row.setting_key, JSON.parse(row.setting_value)])) : undefined;
    return { ...record, rewards: rewards.map((balance) => ({ ...REWARDS.find((reward) => reward.id === balance.id), ...balance })), animations, edits,
      ...(settings === undefined ? {} : { settings }) };
  }

  function writeRecords(id, data) {
    const rewardInsert = database.prepare('INSERT INTO reward_balances VALUES (?, ?, ?, ?)');
    for (const [type, balance] of Object.entries(data.rewards)) rewardInsert.run(id, type, balance.whole, balance.fragments);
    const animationInsert = database.prepare('INSERT INTO collected_animations VALUES (?, ?)');
    for (const animation of data.pokemons) animationInsert.run(id, animation);
    if (data.settings !== undefined) {
      const settingInsert = database.prepare('INSERT INTO import_settings VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(data.settings)) settingInsert.run(id, key, JSON.stringify(value));
    }
  }

  function importData(ownerId, input, ownerName = ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) throw inputError('An authenticated owner is required.', 401);
    const { source, data } = validateImport(input);
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return transaction(() => {
      const existing = database.prepare('SELECT id FROM imports WHERE owner_id = ? AND source = ? AND sha256 = ?').get(ownerId, source, digest);
      if (existing) return { duplicate: true, import: getImport(ownerId, existing.id) };
      const id = randomUUID();
      database.prepare('INSERT INTO imports (id, owner_id, source, format, version, sha256, created_at, current_sha256, owner_name, has_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ownerId, source, data.format, data.version, digest, now(), digest, ownerName, data.settings === undefined ? 0 : 1);
      writeRecords(id, data);
      return { duplicate: false, import: getImport(ownerId, id) };
    });
  }

  function updateImport(actor, id, input) {
    if (!actor?.id || actor.role !== 'admin') throw inputError('Administrator access is required to edit collection data.', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['revision', 'data'].includes(key))
      || !Number.isSafeInteger(input.revision) || input.revision < 1) throw inputError('Provide the current revision and updated collection data.');
    const data = validateExport(input.data);
    return transaction(() => {
      const previous = getImport(actor.id, id, true);
      if (previous.revision !== input.revision) throw inputError('This collection changed. Close and reopen its details before editing again.', 409);
      const replacement = data.settings === undefined && previous.settings !== undefined ? { ...data, settings: previous.settings } : data;
      const digest = createHash('sha256').update(JSON.stringify(replacement)).digest('hex');
      if (previous.sha256 === digest) return previous;
      database.prepare('DELETE FROM reward_balances WHERE import_id = ?').run(id);
      database.prepare('DELETE FROM collected_animations WHERE import_id = ?').run(id);
      database.prepare('DELETE FROM import_settings WHERE import_id = ?').run(id);
      writeRecords(id, replacement);
      const revision = previous.revision + 1;
      const timestamp = now();
      database.prepare('UPDATE imports SET current_sha256 = ?, revision = ?, updated_at = ?, updated_by = ?, has_settings = ? WHERE id = ?')
        .run(digest, revision, timestamp, actor.id, replacement.settings === undefined ? 0 : 1, id);
      database.prepare('INSERT INTO import_edits VALUES (?, ?, ?, ?, ?, ?)').run(id, revision, actor.id, timestamp, previous.sha256, digest);
      return getImport(actor.id, id, true);
    });
  }

  function listImports(ownerId, { search = '', source = '', page = 1, pageSize = 25 } = {}, allowAll = false) {
    const normalizedPage = Number(page);
    const normalizedSize = Number(pageSize);
    if (!Number.isInteger(normalizedPage) || normalizedPage < 1 || normalizedPage > 1_000_000
      || !Number.isInteger(normalizedSize) || normalizedSize < 1 || normalizedSize > 100) throw inputError('Invalid pagination.');
    if (typeof search !== 'string' || search.length > 100 || typeof source !== 'string' || source.length > 80) throw inputError('Invalid filter.');
    const pattern = `%${search.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    const where = " WHERE (owner_id = ? OR ? = 1) AND source LIKE ? ESCAPE '!' AND (? = '' OR source = ?)";
    const parameters = [ownerId, allowAll ? 1 : 0, pattern, source, source];
    const total = database.prepare(`SELECT count(*) AS total FROM imports${where}`).get(...parameters).total;
    return {
      imports: database.prepare(`${summary}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...parameters, normalizedSize, (normalizedPage - 1) * normalizedSize),
      total, page: normalizedPage, pageSize: normalizedSize,
      sources: database.prepare('SELECT DISTINCT source FROM imports WHERE owner_id = ? OR ? = 1 ORDER BY source').all(ownerId, allowAll ? 1 : 0).map((row) => row.source),
    };
  }

  function deleteImport(ownerId, id) {
    if (database.prepare('DELETE FROM imports WHERE owner_id = ? AND id = ?').run(ownerId, id).changes !== 1) throw inputError('Import not found.', 404);
  }

  return { importData, updateImport, listImports, getImport, deleteImport, close: () => database.close() };
}