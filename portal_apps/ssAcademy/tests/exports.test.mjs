import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { FORMAT, MAX_WHOLE, validateExport } from '../server/exports.mjs';
import { createStore } from '../server/store.mjs';

export const sample = () => ({
  source: 'Learning tablet',
  data: { format: FORMAT, version: 1, rewards: { LOLLIPOP: { whole: 3, fragments: 2 }, TOYS_1: { whole: 1, fragments: 0 } }, pokemons: ['PIKACHU', 'BULBASAUR'] },
});

test('validates the upstream collections format and reward-balance limits', () => {
  const input = sample().data;
  assert.deepEqual(validateExport(input).pokemons, ['BULBASAUR', 'PIKACHU']);
  assert.equal(validateExport({ ...input, rewards: { LOLLIPOP: {} } }).rewards.LOLLIPOP.whole, 0);
  assert.equal(validateExport({ ...input, rewards: { LOLLIPOP: { whole: MAX_WHOLE, fragments: 2 } } }).rewards.LOLLIPOP.whole, MAX_WHOLE);
  assert.equal(validateExport({ ...input, pokemons: ['PIKACHU', 'PIKACHU'] }).pokemons.length, 1);
  for (const data of [null, [], {}, { ...input, format: 'other' }, { ...input, version: 2 }, { ...input, history: [] },
    { ...input, rewards: { UNKNOWN: { whole: 1, fragments: 0 } } }, { ...input, rewards: { LOLLIPOP: { whole: -1 } } },
    { ...input, rewards: { LOLLIPOP: { whole: MAX_WHOLE + 1 } } }, { ...input, rewards: { LOLLIPOP: { fragments: 3 } } },
    { ...input, rewards: { LOLLIPOP: { whole: '2' } } }, { ...input, rewards: { LOLLIPOP: { whole: null } } },
    { ...input, pokemons: ['<script>'] }, { ...input, pokemons: null }]) {
    assert.throws(() => validateExport(data), { statusCode: 400 });
  }
});

test('persists normalized rows rather than the export file and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssacademy-'));
  const path = join(directory, 'academy.sqlite');
  let store = createStore({ path });
  try {
    const result = store.importData('owner-a', sample());
    assert.equal(result.duplicate, false);
    assert.equal(result.import.whole, 4);
    assert.equal(result.import.animationCount, 2);
    store.close();
    store = createStore({ path });
    const restored = store.getImport('owner-a', result.import.id);
    assert.deepEqual(restored.animations, ['BULBASAUR', 'PIKACHU']);
    assert.equal(restored.rewards.find((reward) => reward.id === 'LOLLIPOP').fragments, 2);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT count(*) AS count FROM reward_balances').get().count, 2);
      assert.equal(database.prepare('SELECT count(*) AS count FROM collected_animations').get().count, 2);
      assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_table_info('imports') WHERE name IN ('file', 'payload', 'raw_json')").get().count, 0);
    } finally { database.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('duplicate imports are idempotent regardless of reward and animation ordering', () => {
  const store = createStore();
  try {
    const first = store.importData('owner-a', sample());
    const reordered = sample();
    reordered.data.rewards = { TOYS_1: { whole: 1, fragments: 0 }, LOLLIPOP: { whole: 3, fragments: 2 } };
    reordered.data.pokemons.reverse();
    const second = store.importData('owner-a', reordered);
    assert.equal(second.duplicate, true);
    assert.equal(second.import.id, first.import.id);
    assert.equal(store.listImports('owner-a').total, 1);
    assert.equal(store.importData('owner-b', sample()).duplicate, false);
    assert.equal(store.importData('owner-a', { ...sample(), source: 'Second tablet' }).duplicate, false);
  } finally { store.close(); }
});

test('owners cannot read or delete other users data and failed validation changes nothing', () => {
  const store = createStore();
  try {
    const { import: record } = store.importData('owner-a', sample());
    assert.equal(store.listImports('owner-b').total, 0);
    assert.throws(() => store.getImport('owner-b', record.id), { statusCode: 404 });
    assert.throws(() => store.deleteImport('owner-b', record.id), { statusCode: 404 });
    assert.throws(() => store.importData('owner-a', { ...sample(), data: { ...sample().data, rewards: { LOLLIPOP: { whole: -1 } } } }));
    assert.equal(store.listImports('owner-a').total, 1);
    store.deleteImport('owner-a', record.id);
    assert.equal(store.listImports('owner-a').total, 0);
    assert.throws(() => store.getImport('owner-a', record.id), { statusCode: 404 });
  } finally { store.close(); }
});

test('search and pagination are bounded and do not interpret SQL wildcard input', () => {
  const store = createStore();
  try {
    store.importData('owner-a', sample());
    store.importData('owner-a', { ...sample(), source: 'Tablet 100%' });
    assert.equal(store.listImports('owner-a', { search: '%' }).total, 1);
    assert.equal(store.listImports('owner-a', { pageSize: 1 }).imports.length, 1);
    assert.equal(store.listImports('owner-a', { source: 'Learning tablet' }).total, 1);
    assert.equal(store.listImports('owner-a', { search: "' OR 1=1 --" }).total, 0);
    assert.throws(() => store.listImports('owner-a', { pageSize: 1000 }), { statusCode: 400 });
  } finally { store.close(); }
});

test('admin edits update normalized values and keep the original import identity', () => {
  const store = createStore();
  try {
    const original = store.importData('member', sample()).import;
    const changed = sample().data;
    changed.rewards.LOLLIPOP = { whole: 9, fragments: 1 };
    changed.pokemons = ['PIKACHU', 'MEGA_CHARIZARD_X'];
    const edited = store.updateImport({ id: 'administrator', role: 'admin' }, original.id, { revision: 1, data: changed });
    assert.equal(edited.ownerId, 'member');
    assert.equal(edited.revision, 2);
    assert.equal(edited.rewards.find((reward) => reward.id === 'LOLLIPOP').whole, 9);
    assert.deepEqual(edited.animations, ['MEGA_CHARIZARD_X', 'PIKACHU']);
    assert.equal(edited.importedSha256, original.sha256);
    assert.notEqual(edited.sha256, original.sha256);
    assert.equal(edited.updatedBy, 'administrator');
    assert.equal(edited.edits[0].revision, 2);
    assert.equal(store.listImports('administrator').total, 0);
    assert.equal(store.listImports('administrator', {}, true).total, 1);
    const duplicate = store.importData('member', sample());
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.import.revision, 2);
    assert.equal(duplicate.import.sha256, edited.sha256);
  } finally { store.close(); }
});

test('members, stale revisions, and invalid edit values cannot overwrite data', () => {
  const store = createStore();
  try {
    const record = store.importData('member', sample()).import;
    const actor = { id: 'administrator', role: 'admin' };
    const changed = sample().data;
    changed.rewards.LOLLIPOP.whole = 7;
    assert.throws(() => store.updateImport({ id: 'member', role: 'user' }, record.id, { revision: 1, data: changed }), { statusCode: 403 });
    assert.throws(() => store.updateImport(actor, record.id, { revision: 1, ownerId: 'administrator', data: changed }), { statusCode: 400 });
    store.updateImport(actor, record.id, { revision: 1, data: changed });
    assert.throws(() => store.updateImport(actor, record.id, { revision: 1, data: sample().data }), { statusCode: 409 });
    changed.rewards.LOLLIPOP.fragments = 3;
    assert.throws(() => store.updateImport(actor, record.id, { revision: 2, data: changed }), { statusCode: 400 });
    assert.equal(store.getImport('member', record.id).revision, 2);
    assert.equal(store.getImport('member', record.id).rewards.find((reward) => reward.id === 'LOLLIPOP').fragments, 2);
  } finally { store.close(); }
});

test('a failed database write rolls back edited values, revisions, and edit metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssacademy-rollback-'));
  const path = join(directory, 'academy.sqlite');
  const store = createStore({ path });
  const database = new DatabaseSync(path);
  try {
    const original = store.importData('member', sample()).import;
    database.exec("CREATE TRIGGER fail_animation BEFORE INSERT ON collected_animations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const changed = sample().data;
    changed.rewards.LOLLIPOP.whole = 9;
    assert.throws(() => store.updateImport({ id: 'administrator', role: 'admin' }, original.id, { revision: 1, data: changed }), /fixture failure/);
    assert.deepEqual(store.getImport('member', original.id), original);
    assert.throws(() => store.importData('member', { ...sample(), source: 'Failed import' }), /fixture failure/);
    assert.equal(store.listImports('member').total, 1);
  } finally { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});