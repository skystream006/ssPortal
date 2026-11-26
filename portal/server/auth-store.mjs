import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const authError = (statusCode, message, code = 'AUTH_ERROR') => Object.assign(new Error(message), { statusCode, code });
export const hashToken = (token) => createHash('sha256').update(token).digest('base64url');
const randomToken = () => randomBytes(32).toString('base64url');

export function normalizeName(value) {
  if (typeof value !== 'string') throw authError(400, 'Username must be text.');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw authError(400, 'Username must be between 2 and 64 characters.');
  }
  return name;
}

function credentialName(value = 'Passkey') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
    throw authError(400, 'Passkey name must be between 1 and 64 characters.');
  }
  return value.trim();
}

function academyFingerprintHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw authError(400, 'fingerprintToken must contain 32-256 letters, digits, underscores, or hyphens.');
  }
  return createHash('sha256').update(value).digest('hex');
}

export function createAuthStore({ path = ':memory:', now = Date.now, sessionDays = 30 } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      user_handle TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'revoked')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
      transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_hash TEXT NOT NULL,
      payload TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS academy_devices (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL, username_key TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'revoked')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      approved_at INTEGER, approved_by TEXT, expires_at INTEGER, last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS academy_devices_user ON academy_devices(user_id);
    CREATE INDEX IF NOT EXISTS academy_devices_username ON academy_devices(username_key);
  `);
  const deviceColumns = database.prepare("SELECT name FROM pragma_table_info('academy_devices')").all();
  if (!deviceColumns.some((column) => column.name === 'sync_token_hash')) {
    database.exec('ALTER TABLE academy_devices ADD COLUMN sync_token_hash TEXT');
  }
  if (!deviceColumns.some((column) => column.name === 'sync_token_nonce')) {
    database.exec('ALTER TABLE academy_devices ADD COLUMN sync_token_nonce TEXT');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS academy_devices_sync_token ON academy_devices(sync_token_hash) WHERE sync_token_hash IS NOT NULL');

  let deliveryKey;
  function getDeliveryKey() {
    if (deliveryKey) return deliveryKey;
    if (path === ':memory:') { deliveryKey = randomBytes(32); return deliveryKey; }
    const keyPath = `${path}.sync-key`;
    try { deliveryKey = readFileSync(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (database.prepare('SELECT 1 FROM academy_devices WHERE sync_token_nonce IS NOT NULL LIMIT 1').get()) {
        throw new Error('The ssAcademy delivery key is missing. Restore the auth database sync-key file before delivering pending tokens.');
      }
      try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      deliveryKey = readFileSync(keyPath);
    }
    if (deliveryKey.length !== 32) { deliveryKey = undefined; throw new Error('The ssAcademy delivery key is invalid. Restore the auth database sync-key file.'); }
    return deliveryKey;
  }

  const deliveryToken = (id, nonce) => createHmac('sha256', getDeliveryKey()).update(`ssacademy:${id}:${nonce}`).digest('hex');

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const userQuery = `SELECT id, name, role, status, created_at AS createdAt, updated_at AS updatedAt,
    (SELECT count(*) FROM credentials WHERE user_id = users.id) AS credentialCount FROM users`;
  const getUser = (id) => database.prepare(`${userQuery} WHERE id = ?`).get(id) ?? null;
  const isEmpty = () => database.prepare('SELECT count(*) AS count FROM users').get().count === 0;

  function requireApproved(id) {
    const user = getUser(id);
    if (!user || user.status !== 'approved') throw authError(403, 'An approved account is required.', 'ACCESS_REVOKED');
    return user;
  }

  function requireAdmin(id) {
    const user = requireApproved(id);
    if (user.role !== 'admin') throw authError(403, 'Administrator access is required.');
    return user;
  }

  function ensureUniqueName(name, exceptId = '') {
    if (database.prepare('SELECT id FROM users WHERE name_key = ? AND id <> ?').get(name.toLowerCase(), exceptId)) {
      throw authError(409, 'That username is already registered.');
    }
  }

  function insertCredential(userId, credential, name = 'Passkey') {
    if (database.prepare('SELECT id FROM credentials WHERE id = ?').get(credential.id)) {
      throw authError(409, 'That passkey is already registered.');
    }
    database.prepare(`INSERT INTO credentials (id, user_id, name, public_key, counter, transports, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(credential.id, userId, credentialName(name), Buffer.from(credential.publicKey),
      credential.counter, JSON.stringify(credential.transports ?? []), now());
  }

  function issueEnrollmentCode(kind, userId = null) {
    return transaction(() => {
      if (kind === 'setup' && !isEmpty()) throw authError(409, 'Administrator setup is already complete.');
      if (kind === 'recovery') requireApproved(userId);
      if (!['setup', 'recovery'].includes(kind)) throw authError(400, 'Invalid enrollment type.');
      const token = randomToken();
      const expiresAt = now() + 15 * 60_000;
      database.prepare('DELETE FROM enrollment_tokens WHERE kind = ? AND user_id IS ?').run(kind, userId);
      database.prepare('INSERT INTO enrollment_tokens VALUES (?, ?, ?, ?)').run(hashToken(token), kind, userId, expiresAt);
      return { token, expiresAt };
    });
  }

  function checkEnrollmentCode(token, kind) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw authError(403, 'Invalid or expired setup/recovery code.');
    const tokenHash = hashToken(token);
    const record = database.prepare('SELECT * FROM enrollment_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?')
      .get(tokenHash, kind, now());
    if (!record) throw authError(403, 'Invalid or expired setup/recovery code.');
    return { tokenHash, userId: record.user_id };
  }

  function consumeEnrollmentCode(tokenHash, kind, userId = null) {
    const result = database.prepare('DELETE FROM enrollment_tokens WHERE token_hash = ? AND kind = ? AND user_id IS ? AND expires_at > ?')
      .run(tokenHash, kind, userId, now());
    if (result.changes !== 1) throw authError(403, 'Invalid or expired setup/recovery code.');
  }

  function registerUser({ name, userHandle, credential, passkeyName, setupHash = null }) {
    return transaction(() => {
      const normalized = normalizeName(name);
      ensureUniqueName(normalized);
      const first = isEmpty();
      if (first) consumeEnrollmentCode(setupHash, 'setup');
      else if (setupHash) throw authError(409, 'Administrator setup is already complete.');
      const id = randomUUID();
      const timestamp = now();
      database.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, normalized, normalized.toLowerCase(), userHandle, first ? 'admin' : 'user', first ? 'approved' : 'pending', timestamp, timestamp);
      insertCredential(id, credential, passkeyName);
      if (first) database.prepare("DELETE FROM enrollment_tokens WHERE kind = 'setup'").run();
      return getUser(id);
    });
  }

  function renameUser(userId, name) {
    return transaction(() => {
      requireApproved(userId);
      const normalized = normalizeName(name);
      ensureUniqueName(normalized, userId);
      database.prepare('UPDATE users SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
        .run(normalized, normalized.toLowerCase(), now(), userId);
      return getUser(userId);
    });
  }

  function updateUser(actorId, userId, changes) {
    return transaction(() => {
      requireAdmin(actorId);
      const user = getUser(userId);
      if (!user) throw authError(404, 'User not found.');
      const role = changes.role ?? user.role;
      const status = changes.status ?? user.status;
      if (!['admin', 'user'].includes(role) || !['pending', 'approved', 'revoked'].includes(status)) {
        throw authError(400, 'Invalid role or access status.');
      }
      if (userId === actorId && status !== 'approved') throw authError(409, 'You cannot revoke your own access.');
      if (user.role === 'admin' && user.status === 'approved' && (role !== 'admin' || status !== 'approved')
        && database.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin' AND status = 'approved' AND id <> ?").get(userId).count === 0) {
        throw authError(409, 'At least one approved administrator is required.');
      }
      const name = normalizeName(changes.name ?? user.name);
      ensureUniqueName(name, userId);
      database.prepare('UPDATE users SET name = ?, name_key = ?, role = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(name, name.toLowerCase(), role, status, now(), userId);
      if (role !== user.role || status !== user.status) {
        database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        database.prepare('DELETE FROM enrollment_tokens WHERE user_id = ?').run(userId);
        database.prepare("UPDATE academy_devices SET status = 'revoked', sync_token_hash = NULL, sync_token_nonce = NULL, updated_at = ? WHERE user_id = ?").run(now(), userId);
      }
      return getUser(userId);
    });
  }

  function deleteUser(actorId, userId) {
    return transaction(() => {
      requireAdmin(actorId);
      const user = getUser(userId);
      if (!user) throw authError(404, 'User not found.');
      if (userId === actorId) throw authError(409, 'You cannot delete your own account.');
      if (user.role === 'admin' && user.status === 'approved'
        && database.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin' AND status = 'approved' AND id <> ?").get(userId).count === 0) {
        throw authError(409, 'At least one approved administrator is required.');
      }
      database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
  }

  function findCredential(id) {
    if (typeof id !== 'string') return null;
    const record = database.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
    if (!record) return null;
    return {
      user: getUser(record.user_id),
      userHandle: database.prepare('SELECT user_handle FROM users WHERE id = ?').get(record.user_id).user_handle,
      credential: { id: record.id, publicKey: new Uint8Array(record.public_key), counter: record.counter, transports: JSON.parse(record.transports) },
    };
  }

  function getPasskeys(userId) {
    return database.prepare(`SELECT id, name, transports, created_at AS createdAt, last_used_at AS lastUsedAt
      FROM credentials WHERE user_id = ? ORDER BY created_at`).all(userId)
      .map((credential) => ({ ...credential, transports: JSON.parse(credential.transports) }));
  }

  function addCredential(userId, credential, name) {
    return transaction(() => {
      const user = requireApproved(userId);
      if (user.credentialCount >= 20) throw authError(409, 'An account can have at most 20 passkeys.');
      insertCredential(userId, credential, name);
      return getUser(userId);
    });
  }

  function deleteCredential(userId, credentialId) {
    return transaction(() => {
      const user = requireApproved(userId);
      if (!database.prepare('SELECT id FROM credentials WHERE user_id = ? AND id = ?').get(userId, credentialId)) throw authError(404, 'Passkey not found.');
      if (user.credentialCount <= 1) throw authError(409, 'You must keep at least one passkey.');
      database.prepare('DELETE FROM credentials WHERE id = ?').run(credentialId);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return getUser(userId);
    });
  }

  function updateCounter(credentialId, previous, next) {
    const result = database.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?')
      .run(next, now(), credentialId, previous);
    if (result.changes !== 1) throw authError(401, 'This passkey changed. Please sign in again.');
  }

  function createSession(userId) {
    return transaction(() => {
      requireApproved(userId);
      const token = randomToken();
      const expiresAt = now() + sessionDays * 86_400_000;
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
      database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now(), expiresAt);
      database.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
        (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20)`).run(userId, userId);
      return { token, expiresAt };
    });
  }

  function getSessionUser(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = database.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), now());
    const user = session ? getUser(session.user_id) : null;
    return user?.status === 'approved' ? user : null;
  }

  function rememberChallenge(kind, binding, payload) {
    return transaction(() => {
      database.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now());
      const bindingHash = hashToken(binding);
      if (database.prepare('SELECT count(*) AS count FROM challenges').get().count >= 5000
        || database.prepare('SELECT count(*) AS count FROM challenges WHERE binding_hash = ?').get(bindingHash).count >= 10) {
        throw authError(429, 'Too many passkey requests. Please try again later.');
      }
      const id = randomToken();
      database.prepare('INSERT INTO challenges VALUES (?, ?, ?, ?, ?)').run(id, kind, bindingHash, JSON.stringify(payload), now() + 5 * 60_000);
      return id;
    });
  }

  function takeChallenge(id, kind, binding) {
    if (typeof id !== 'string' || typeof binding !== 'string') throw authError(400, 'The passkey request expired. Please try again.');
    const record = transaction(() => {
      const challenge = database.prepare('SELECT * FROM challenges WHERE id = ? AND binding_hash = ?').get(id, hashToken(binding));
      if (challenge) database.prepare('DELETE FROM challenges WHERE id = ?').run(id);
      return challenge;
    });
    if (!record || record.kind !== kind || record.expires_at <= now()) throw authError(400, 'The passkey request expired. Please try again.');
    return JSON.parse(record.payload);
  }

  function recoverAccount(userId, tokenHash, credential, name) {
    return transaction(() => {
      requireApproved(userId);
      consumeEnrollmentCode(tokenHash, 'recovery', userId);
      database.prepare('DELETE FROM credentials WHERE user_id = ?').run(userId);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      database.prepare("UPDATE academy_devices SET status = 'revoked', sync_token_hash = NULL, sync_token_nonce = NULL, updated_at = ? WHERE user_id = ?").run(now(), userId);
      insertCredential(userId, credential, name);
      return getUser(userId);
    });
  }

  function academyDevice(record) {
    const user = record.user_id ? getUser(record.user_id) : null;
    const status = record.status === 'approved' && record.expires_at <= now() ? 'expired' : record.status;
    return {
      id: record.id, student: record.username, userId: record.user_id,
      accountName: user?.name ?? null, accountStatus: user?.status ?? null,
      fingerprint: record.token_hash.slice(0, 16), status,
      hasBearerToken: record.sync_token_hash !== null,
      createdAt: record.created_at, updatedAt: record.updated_at,
      approvedAt: record.approved_at, approvedBy: record.approved_by,
      expiresAt: record.expires_at, lastUsedAt: record.last_used_at,
    };
  }

  function registerAcademyDevice(student, fingerprintToken) {
    const name = normalizeName(student);
    const nameKey = name.toLowerCase();
    const tokenHash = academyFingerprintHash(fingerprintToken);
    return transaction(() => {
      const existing = database.prepare('SELECT * FROM academy_devices WHERE token_hash = ?').get(tokenHash);
      if (existing) {
        if (existing.username_key !== nameKey) throw authError(409, 'This app token is already registered to a different student.');
        return { created: false, device: academyDevice(existing) };
      }
      if (database.prepare('SELECT count(*) AS count FROM academy_devices').get().count >= 2000
        || database.prepare('SELECT count(*) AS count FROM academy_devices WHERE username_key = ?').get(nameKey).count >= 20) {
        throw authError(429, 'The app registration limit has been reached. Contact an administrator.');
      }
      const user = database.prepare('SELECT id FROM users WHERE name_key = ?').get(nameKey);
      const id = randomUUID();
      const timestamp = now();
      database.prepare(`INSERT INTO academy_devices (id, token_hash, username, username_key, user_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, tokenHash, name, nameKey, user?.id ?? null, timestamp, timestamp);
      return { created: true, device: academyDevice(database.prepare('SELECT * FROM academy_devices WHERE id = ?').get(id)) };
    });
  }

  function getAcademyDeviceStatus(student, fingerprintToken) {
    const nameKey = normalizeName(student).toLowerCase();
    const tokenHash = academyFingerprintHash(fingerprintToken);
    const record = database.prepare('SELECT * FROM academy_devices WHERE token_hash = ? AND username_key = ?').get(tokenHash, nameKey);
    if (!record) throw authError(404, 'App registration not found.');
    return academyDevice(record);
  }

  function claimAcademyBearerToken(student, fingerprintToken) {
    const nameKey = normalizeName(student).toLowerCase();
    const tokenHash = academyFingerprintHash(fingerprintToken);
    return transaction(() => {
      const record = database.prepare('SELECT * FROM academy_devices WHERE token_hash = ? AND username_key = ?').get(tokenHash, nameKey);
      if (!record) throw authError(404, 'App registration not found.');
      const device = academyDevice(record);
      if (device.status !== 'approved' || !record.sync_token_nonce) return { device };
      const bearerToken = deliveryToken(record.id, record.sync_token_nonce);
      if (hashToken(bearerToken) !== record.sync_token_hash) throw new Error('The ssAcademy delivery key does not match the pending token.');
      database.prepare('UPDATE academy_devices SET sync_token_nonce = NULL WHERE id = ?').run(record.id);
      return { device, bearerToken };
    });
  }

  function listAcademyDevices(actorId, { status = '', search = '', page = 1, pageSize = 50 } = {}) {
    requireAdmin(actorId);
    const pageNumber = Number(page);
    const size = Number(pageSize);
    if (!['', 'pending', 'approved', 'revoked', 'expired'].includes(status) || typeof search !== 'string' || search.length > 100
      || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 10000 || !Number.isInteger(size) || size < 1 || size > 100) {
      throw authError(400, 'Invalid device filters or pagination.');
    }
    const pattern = `%${search.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    const where = ` WHERE username LIKE ? ESCAPE '!' AND (? = '' OR
      CASE WHEN status = 'approved' AND expires_at <= ? THEN 'expired' ELSE status END = ?)`;
    const values = [pattern, status, now(), status];
    const total = database.prepare(`SELECT count(*) AS count FROM academy_devices${where}`).get(...values).count;
    const records = database.prepare(`SELECT * FROM academy_devices${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...values, size, (pageNumber - 1) * size);
    return { devices: records.map(academyDevice), total, page: pageNumber, pageSize: size };
  }

  function updateAcademyDevice(actorId, id, status) {
    return transaction(() => {
      requireAdmin(actorId);
      if (!['approved', 'revoked'].includes(status)) throw authError(400, 'Choose approved or revoked access.');
      const record = database.prepare('SELECT * FROM academy_devices WHERE id = ?').get(id);
      if (!record) throw authError(404, 'App registration not found.');
      if (status === 'approved') {
        const nonce = randomBytes(32).toString('hex');
        const bearerToken = deliveryToken(id, nonce);
        const timestamp = now();
        database.prepare(`UPDATE academy_devices SET status = 'approved', sync_token_hash = ?, sync_token_nonce = ?, updated_at = ?, approved_at = ?, approved_by = ?, expires_at = ? WHERE id = ?`)
          .run(hashToken(bearerToken), nonce, timestamp, timestamp, actorId, timestamp + 90 * 86_400_000, id);
      } else {
        database.prepare("UPDATE academy_devices SET status = 'revoked', sync_token_hash = NULL, sync_token_nonce = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      }
      const device = academyDevice(database.prepare('SELECT * FROM academy_devices WHERE id = ?').get(id));
      return { device };
    });
  }

  function getAcademyDeviceUser(bearerToken) {
    if (typeof bearerToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(bearerToken)) return null;
    const record = database.prepare("SELECT id, user_id, username FROM academy_devices WHERE sync_token_hash = ? AND status = 'approved' AND expires_at > ?")
      .get(hashToken(bearerToken), now());
    if (!record) return null;
    const user = record.user_id ? getUser(record.user_id) : null;
    database.prepare('UPDATE academy_devices SET last_used_at = ? WHERE id = ?').run(now(), record.id);
    return { id: record.user_id ?? `ssacademy-device:${record.id}`, name: user?.name ?? record.username, role: 'user' };
  }

  function deleteAcademyDevice(actorId, id) {
    requireAdmin(actorId);
    if (database.prepare('DELETE FROM academy_devices WHERE id = ?').run(id).changes !== 1) throw authError(404, 'App registration not found.');
  }

  return {
    close: () => database.close(), isEmpty, getUser, registerUser, renameUser, updateUser, deleteUser,
    listUsers: (actorId) => { requireAdmin(actorId); return database.prepare(`${userQuery} ORDER BY created_at, name`).all(); },
    getUserHandle: (id) => database.prepare('SELECT user_handle FROM users WHERE id = ?').get(id)?.user_handle,
    findUserByName: (name) => database.prepare(`${userQuery} WHERE name_key = ?`).get(normalizeName(name).toLowerCase()) ?? null,
    findCredential, getPasskeys, addCredential, deleteCredential, updateCounter, createSession, getSessionUser,
    deleteSession: (token) => { if (typeof token === 'string') database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); },
    revokeSessions: (actorId, userId) => { requireAdmin(actorId); requireApproved(userId); database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); },
    issueEnrollmentCode, checkEnrollmentCode, recoverAccount, rememberChallenge, takeChallenge,
    registerAcademyDevice, getAcademyDeviceStatus, claimAcademyBearerToken, listAcademyDevices, updateAcademyDevice, getAcademyDeviceUser, deleteAcademyDevice,
  };
}