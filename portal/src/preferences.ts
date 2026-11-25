export const themes = [
  { id: 'midnight', name: 'Midnight blue' },
  { id: 'maize-blue', name: 'Maize and blue' },
  { id: 'royal-purple', name: 'Royal purple' },
  { id: 'gold', name: 'Gold' },
  { id: 'green', name: 'Green' },
  { id: 'pink', name: 'Pink' },
  { id: 'black', name: 'Black' },
] as const;

export type Theme = typeof themes[number]['id'];
export type Mode = 'light' | 'dark' | 'system';
export type Preferences = { theme: Theme; mode: Mode; newTab: boolean; autoRefresh: boolean; view: 'grid' | 'list' };
export const defaults: Preferences = { theme: 'green', mode: 'system', newTab: true, autoRefresh: true, view: 'grid' };

export function readStored(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(`ssportal.${key}`) ?? 'null'); }
  catch { return null; }
}

export function readPreferences(): Preferences {
  const stored = readStored('preferences');
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const saved = stored as Partial<Preferences>;
  return {
    theme: themes.some((theme) => theme.id === saved.theme) ? saved.theme! : defaults.theme,
    mode: ['light', 'dark', 'system'].includes(saved.mode ?? '') ? saved.mode! : defaults.mode,
    newTab: typeof saved.newTab === 'boolean' ? saved.newTab : defaults.newTab,
    autoRefresh: typeof saved.autoRefresh === 'boolean' ? saved.autoRefresh : defaults.autoRefresh,
    view: saved.view === 'list' ? 'list' : 'grid',
  };
}

export function readFavorites(userId: string): string[] {
  const saved = readStored(`${userId}.favorites`);
  return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string').slice(0, 50) : [];
}

export type Visit = { id: string; at: string };
export function readVisits(userId: string): Visit[] {
  const saved = readStored(`${userId}.visits`);
  return Array.isArray(saved) ? saved.filter((entry): entry is Visit => entry && typeof entry.id === 'string'
    && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))).slice(0, 5) : [];
}