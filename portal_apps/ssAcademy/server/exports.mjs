export const FORMAT = 'ssAcademy-collections';
export const VERSION = 1;
export const MAX_EXPORT_BYTES = 256 * 1024;
export const MAX_WHOLE = Math.floor((2_147_483_647 - 2) / 3);
export const UPSTREAM_REVISION = '0f603630936f58d2546448cbb5968a6bd989a997';
export const REWARDS = [
  { id: 'LOLLIPOP', label: 'Lollipop', tier: 1 },
  { id: 'ICE_CREAM', label: 'Ice Cream Cone', tier: 1 },
  { id: 'GUMMI_BEAR', label: 'Gummi Bear', tier: 1 },
  { id: 'RAMEN', label: 'Ramen', tier: 1 },
  { id: 'BED_TIME', label: 'Bed Time', tier: 1 },
  { id: 'VIDEO_GAME', label: 'Video Game', tier: 2 },
  { id: 'RESTAURANT', label: 'Restaurant', tier: 2 },
  { id: 'TOYS_1', label: '$1 Toys', tier: 3 },
  { id: 'TOYS_2', label: '$2 Toys', tier: 3 },
  { id: 'TOYS_3', label: '$3 Toys', tier: 3 },
  { id: 'GOOD_BEHAVIOR_POINT', label: '1 Good Behavior Point', tier: 3 },
];
const rewardIds = new Set(REWARDS.map((reward) => reward.id));
export const inputError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function object(value, keys, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw inputError(`Invalid ${description}.`);
  }
}

export function normalizeSource(value) {
  if (typeof value !== 'string') throw inputError('Source must be a label between 1 and 80 characters.');
  const source = value.normalize('NFKC').trim();
  if (!source || source.length > 80 || /[\u0000-\u001f\u007f]/.test(source)) throw inputError('Source must be a label between 1 and 80 characters.');
  return source;
}

export function validateExport(input) {
  object(input, ['format', 'version', 'rewards', 'pokemons'], 'ssAcademy export object');
  if (input.format !== FORMAT) throw inputError(`Expected format "${FORMAT}".`);
  if (input.version !== VERSION) throw inputError('Only ssAcademy collections export version 1 is supported.');
  object(input.rewards, [...rewardIds], 'reward balances');
  if (!Array.isArray(input.pokemons) || input.pokemons.length > 2048) throw inputError('pokemons must contain at most 2048 animation identifiers.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_EXPORT_BYTES) throw inputError('Export data exceeds 256 KiB.', 413);
  const rewards = {};
  for (const id of Object.keys(input.rewards).sort()) {
    const balance = input.rewards[id];
    object(balance, ['whole', 'fragments'], `balance for ${id}`);
    const whole = balance.whole ?? 0;
    const fragments = balance.fragments ?? 0;
    if (balance.whole === null || balance.fragments === null || !Number.isInteger(whole)
      || whole < 0 || whole > MAX_WHOLE || !Number.isInteger(fragments) || fragments < 0 || fragments > 2) {
      throw inputError(`Invalid balance for ${id}: whole must be 0-${MAX_WHOLE}, fragments must be 0-2.`);
    }
    rewards[id] = { whole, fragments };
  }
  for (const id of input.pokemons) {
    if (typeof id !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(id)) throw inputError('Animation identifiers must be uppercase enum names of at most 100 characters.');
  }
  return { format: FORMAT, version: VERSION, rewards, pokemons: [...new Set(input.pokemons)].sort() };
}

export function validateImport(input) {
  object(input, ['source', 'data'], 'import request');
  return { source: normalizeSource(input.source), data: validateExport(input.data) };
}