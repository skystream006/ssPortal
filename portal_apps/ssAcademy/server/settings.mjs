// This allowlist mirrors Android's PortalSettings; identity, PINs and activity data are never portable.
const schema = new Map();
const bool = keys => keys.forEach(key => schema.set(key, { type: 'boolean' }));
const ints = (keys, min, max) => keys.forEach(key => schema.set(key, { type: 'integer', min, max }));
const choices = (key, values, set = false) => schema.set(key, { type: set ? 'set' : 'string', values });
const operations = ['ADDITION', 'SUBTRACTION', 'MULTIPLICATION', 'DIVISION'];
const mathGames = ['BASIC', 'LOGIC', 'MATRIX'];
const readingGames = ['MISSING', 'SCRAMBLE', 'SEQUENCE', 'DETECTIVE', 'STUDIO', 'GRAMMAR'];
bool(['slot_machine_fragment_reward', 'show_timer', 'math_pause_in_background',
  'rewards_enabled', 'reading_rewards_enabled', 'science_rewards_enabled', 'advanced_rewards_enabled',
  'show_submitted_answer', 'show_correct_answers', 'vertical_equations', 'randomize_matrix_questions',
  'wave_appearance', 'skins_enabled']);
ints(['minimum', 'maximum', 'division_maximum_first', 'division_maximum_second',
  'multiplication_maximum_first', 'multiplication_maximum_second'], 1, 10000);
ints(['question_count'], 1, 1000);
ints(['text_size_percent'], 80, 200);
ints(['time_limit_minutes'], 0, 15);
ints(['time_limit_seconds', 'matrix_time_limit_seconds', 'logic_time_limit_seconds',
  'reading_time_limit_seconds', 'science_time_limit_seconds', 'advanced_time_limit_seconds'], 0, 900);
choices('operation', operations);
choices('theme', ['midnight', 'royal-purple', 'gold', 'green', 'pink', 'black']);
choices('mode', ['dark', 'light']);
choices('skin', ['CHERRY_BLOSSOM', 'STARRY_CITY', 'OCEAN_WAVE', 'OCEAN_MOONLIGHT', 'GALAXY',
  'TROPICAL', 'MECHANICS', 'AURORA_BOREALIS', 'DESERT_DUNES', 'BAMBOO_GROVE', 'AUTUMN_RIVER',
  'ALPINE_DAWN', 'RAINY_WINDOW', 'VOLCANIC_EMBER', 'CRYSTAL_CAVERN', 'PAPER_LANTERNS', 'SYNTHWAVE_GRID']);
choices('matrix_reward_tier', ['TIER_1', 'TIER_2', 'TIER_3']);
choices('disabled_rewards', ['LOLLIPOP', 'ICE_CREAM', 'GUMMI_BEAR', 'RAMEN', 'VIDEO_GAME', 'BED_TIME',
  'RESTAURANT', 'TOYS_1', 'TOYS_2', 'TOYS_3', 'GOOD_BEHAVIOR_POINT'], true);
choices('disabled_math_game_rewards', mathGames, true);
choices('disabled_reading_games', readingGames, true);
choices('disabled_reading_game_rewards', readingGames, true);
const thresholdPrefixes = ['reward', ...mathGames.map(game => `math_${game.toLowerCase()}_reward`),
  ...readingGames.map(game => `reading_${game.toLowerCase()}_reward`)];
for (const prefix of thresholdPrefixes) {
  for (let tier = 1; tier <= 3; tier++) ints([`${prefix}_tier_${tier}_minimum`], 1, tier === 3 ? 1001 : 1000);
}
const chanceKeys = ['toys_1', 'toys_2', 'toys_3', 'good_behavior_point']
  .map(type => `reward_tier_3_${type}_percentage`);
ints(chanceKeys, 0, 100);
ints(['logic_minimum_pictures', 'logic_maximum_pictures'], 2, 6);
ints(['logic_minimum_length', 'logic_maximum_length'], 2, 8);
for (const operation of operations) {
  for (const prefix of [`rewards_${operation}_`, `logic_rewards_${operation}_`]) {
    ints([`${prefix}first`, `${prefix}second`], 1, 10000);
  }
}
ints(['rewards_MULTIPLICATION_maximum_first', 'rewards_MULTIPLICATION_maximum_second'], 1, 10000);

function invalid() {
  const error = new Error('Invalid or unsupported ssAcademy settings.');
  error.statusCode = 400;
  throw error;
}

/** Validate a complete saved-override snapshot, not a patch. Empty means all defaults. */
export function validateSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Object.keys(input);
  if (keys.length > 128) invalid();
  let size;
  try { size = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { invalid(); }
  if (size > 64 * 1024) invalid();
  const output = {};
  const validString = value => typeof value === 'string' && value.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  for (const key of keys.sort()) {
    const rule = schema.get(key);
    if (!rule) invalid();
    const value = input[key];
    switch (rule.type) {
      case 'boolean':
        if (typeof value !== 'boolean') invalid();
        output[key] = value;
        break;
      case 'integer':
        if (!Number.isInteger(value) || value < rule.min || value > rule.max) invalid();
        output[key] = value;
        break;
      case 'string':
        if (!validString(value) || !rule.values.includes(value)) invalid();
        output[key] = value;
        break;
      case 'set':
        if (!Array.isArray(value) || value.length > 256 ||
            value.some(item => !validString(item) || !rule.values.includes(item))) invalid();
        output[key] = [...new Set(value)].sort();
        break;
    }
  }
  const number = (key, fallback) => output[key] ?? fallback;
  if (number('minimum', 1) > number('maximum', 10)) invalid();
  const legacy = [number('reward_tier_1_minimum', 25), number('reward_tier_2_minimum', 50),
    number('reward_tier_3_minimum', Math.max(100, number('reward_tier_2_minimum', 50) + 1))];
  for (const prefix of thresholdPrefixes) {
    const tiers = [1, 2, 3].map((tier, index) => number(`${prefix}_tier_${tier}_minimum`, legacy[index]));
    if (!(tiers[0] < tiers[1] && tiers[1] < tiers[2])) invalid();
  }
  if (chanceKeys.some(key => Object.hasOwn(output, key)) &&
      chanceKeys.reduce((sum, key, index) => sum + number(key, [34, 33, 33, 0][index]), 0) !== 100) invalid();
  const minPictures = number('logic_minimum_pictures', 2);
  const maxPictures = number('logic_maximum_pictures', 3);
  const minLength = number('logic_minimum_length', 3);
  const maxLength = number('logic_maximum_length', 4);
  if (minPictures > maxPictures || minLength > maxLength ||
      minPictures > minLength || maxPictures > maxLength) invalid();
  for (const operation of operations) {
    const prefix = `rewards_${operation}_`;
    const first = number(`${prefix}first`, operation === 'DIVISION'
      ? number('division_maximum_first', number('maximum', 10)) : number('minimum', 1));
    const second = number(`${prefix}second`, operation === 'DIVISION'
      ? number('division_maximum_second', number('maximum', 10)) : number('maximum', 10));
    const logicFirst = number(`logic_rewards_${operation}_first`, first);
    const logicSecond = number(`logic_rewards_${operation}_second`, second);
    if (operation !== 'DIVISION' && (first > second || logicFirst > logicSecond)) invalid();
  }
  return output;
}
