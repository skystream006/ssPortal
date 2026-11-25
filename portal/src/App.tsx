import { useEffect, useState } from 'preact/hooks';
import {
  Activity, AppWindow, ArrowDownAZ, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight,
  CircleAlert, ExternalLink, Folder, Globe2, Grid2X2, Info, Layers3,
  LayoutGrid, List, LogOut, Monitor, Moon, Music2, Network, Palette, RefreshCw, RotateCcw,
  Search, Server, ShoppingBasket, Star, Sun, UserRound, Users, X,
} from 'lucide-preact';
import { defaults, readFavorites, readPreferences, themes } from './preferences';
import type { Mode, Preferences } from './preferences';
import { api, AuthenticationScreen, useAuth } from './auth';
import { IconButton, Modal } from './components';
import { AccountSettings, UserAdministration } from './Account';

type Health = { state: 'online' | 'offline' | 'degraded' | 'unchecked'; responseTime: number | null; checkedAt: string | null };
type Application = {
  id: string; name: string; description: string; category: string; path: string;
  apiPath: string | null; icon: string; color: string; runtime: string; source: string; health: Health;
};
type Overview = { apps: Application[]; checkedAt: string; server: { version: string; uptime: number; memoryMb: number } };
type Page = 'applications' | 'favorites' | 'services' | 'account' | 'users';
const pages = [
  { id: 'applications' as const, name: 'Applications', Icon: LayoutGrid },
  { id: 'favorites' as const, name: 'Favorites', Icon: Star },
  { id: 'services' as const, name: 'Services', Icon: Activity },
  { id: 'users' as const, name: 'Users', Icon: Users },
];
const healthLabels = { online: 'Available', offline: 'Unavailable', degraded: 'Needs attention', unchecked: 'Not checked' };
const icons = { 'shopping-basket': ShoppingBasket, network: Network, 'app-window': AppWindow, music: Music2, folder: Folder, 'book-open': BookOpen };
const currentPage = (): Page => location.hash === '#account' ? 'account' : pages.find((page) => `#${page.id}` === location.hash)?.id ?? 'applications';

function AppIcon({ application, small = false }: { application: Application; small?: boolean }) {
  const Icon = icons[application.icon as keyof typeof icons] ?? AppWindow;
  return <span className={`app-icon tone-${application.color} ${small ? 'small' : ''}`}>
    {['grocy', 'webtrees', 'ssacademy'].includes(application.id)
      ? <img src={`/icons/${application.id}.png`} alt="" width={small ? 24 : 42} height={small ? 24 : 42} />
      : <Icon size={small ? 22 : 34} strokeWidth={1.6} />}
  </span>;
}

function Status({ health }: { health: Health }) {
  return <span className={`status status-${health.state}`} title={health.checkedAt ? `Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : undefined}>
    <span className="status-dot" />{healthLabels[health.state]}
  </span>;
}

function Appearance({ preferences, update, close }: {
  preferences: Preferences; update: (next: Preferences) => void; close: () => void;
}) {
  const modes: { id: Mode; name: string; Icon: typeof Sun }[] = [
    { id: 'light', name: 'Light', Icon: Sun }, { id: 'dark', name: 'Dark', Icon: Moon }, { id: 'system', name: 'System', Icon: Monitor },
  ];
  return <Modal title="Appearance" onClose={close}>
    <fieldset className="setting-group"><legend>Color mode</legend>
      <div className="mode-control">{modes.map(({ id, name, Icon }) => <button key={id} type="button" aria-pressed={preferences.mode === id}
        onClick={() => update({ ...preferences, mode: id })}><Icon size={18} />{name}</button>)}</div>
    </fieldset>
    <fieldset className="setting-group"><legend>Theme</legend>
      <div className="theme-grid">{themes.map((theme) => <button key={theme.id} type="button" className={`theme-option swatch-${theme.id}`}
        aria-label={`${theme.name} theme`} aria-pressed={preferences.theme === theme.id} onClick={() => update({ ...preferences, theme: theme.id })}>
        <span className="theme-preview"><span /><span /><span />{preferences.theme === theme.id && <Check size={18} />}</span>
        <span>{theme.name}</span>
      </button>)}</div>
    </fieldset>
    <div className="preference-row"><span><ExternalLink size={17} />Open apps in a new tab</span>
      <input className="switch" type="checkbox" aria-label="Open apps in a new tab" checked={preferences.newTab}
        onChange={(event) => update({ ...preferences, newTab: event.currentTarget.checked })} /></div>
    <div className="preference-row"><span><RefreshCw size={17} />Automatic status refresh</span>
      <input className="switch" type="checkbox" aria-label="Automatic status refresh" checked={preferences.autoRefresh}
        onChange={(event) => update({ ...preferences, autoRefresh: event.currentTarget.checked })} /></div>
    <div className="modal-footer"><button className="text-button" type="button" onClick={() => update({ ...defaults })}><RotateCcw size={16} />Reset appearance</button>
      <button className="primary-button" type="button" onClick={close}><Check size={17} />Done</button></div>
  </Modal>;
}

function ServiceTable({ applications, newTab }: { applications: Application[]; newTab: boolean }) {
  return <div className="table-scroll"><table className="service-table"><thead><tr>
    <th>Application</th><th>Status</th><th>Path</th><th>Response</th><th><span className="sr-only">Open application</span></th>
  </tr></thead><tbody>{applications.map((application) => <tr key={application.id}>
    <td><span className="table-app"><AppIcon application={application} small /><span><strong>{application.name}</strong><small>{application.category}</small></span></span></td>
    <td><Status health={application.health} /></td><td><code>{application.path}</code></td>
    <td className="response-time">{application.health.responseTime === null ? <span className="muted">N/A</span> : <>{application.health.responseTime}<small> ms</small></>}</td>
    <td><a className="icon-button" href={application.path} target={newTab ? '_blank' : undefined} rel="noopener noreferrer" title={`Open ${application.name}`}
      aria-label={`Open ${application.name}`}><ArrowUpRight size={18} /></a></td>
  </tr>)}</tbody></table></div>;
}

export function App() {
  const auth = useAuth();
  const { user } = auth;
  const [preferences, setPreferences] = useState(readPreferences);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [page, setPage] = useState(currentPage);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('name');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [appearance, setAppearance] = useState(false);
  const [details, setDetails] = useState<Application | null>(null);

  function persist(key: string, value: unknown) {
    const scopedKey = key === 'preferences' ? key : `${user?.id}.${key}`;
    try { localStorage.setItem(`ssportal.${scopedKey}`, JSON.stringify(value)); }
    catch { setStorageError(true); }
  }

  function updatePreferences(next: Preferences) {
    setPreferences(next);
    persist('preferences', next);
  }

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = preferences.theme;
      document.documentElement.dataset.themeMode = preferences.mode === 'system' ? (media.matches ? 'dark' : 'light') : preferences.mode;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences.theme, preferences.mode]);

  useEffect(() => {
    setFavorites(user ? readFavorites(user.id) : []);
    setOverview(null);
    setDetails(null);
  }, [user?.id]);

  useEffect(() => {
    const navigate = () => { setPage(currentPage()); setQuery(''); setCategory('all'); };
    const sync = (event: StorageEvent) => {
      if (event.key === 'ssportal.preferences') setPreferences(readPreferences());
      if (user && event.key === `ssportal.${user.id}.favorites`) setFavorites(readFavorites(user.id));
    };
    window.addEventListener('hashchange', navigate);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('hashchange', navigate); window.removeEventListener('storage', sync); };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      setRefreshing(true);
      try {
        const data = await api<Overview>('/apps', { signal: controller.signal });
        if (!Array.isArray(data.apps)) throw new Error('The portal returned an invalid response.');
        if (active) { setOverview(data); setError(''); }
      } catch {
        if (active) setError('Unable to refresh application status.');
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
        if (active) setRefreshing(false);
      }
    }
    void load();
    const poll = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = preferences.autoRefresh ? window.setInterval(poll, 30_000) : null;
    if (preferences.autoRefresh) document.addEventListener('visibilitychange', poll);
    return () => { active = false; controller?.abort(); if (interval) window.clearInterval(interval); document.removeEventListener('visibilitychange', poll); };
  }, [preferences.autoRefresh, refreshKey, user?.id]);

  function toggleFavorite(application: Application) {
    const next = favorites.includes(application.id) ? favorites.filter((id) => id !== application.id) : [...favorites, application.id];
    setFavorites(next);
    persist('favorites', next);
  }

  const applications = (overview?.apps ?? []).map((application) => error
    ? { ...application, health: { ...application.health, state: 'unchecked' as const } } : application);
  const online = applications.filter((application) => application.health.state === 'online').length;
  const categories = [...new Set(applications.map((application) => application.category))].sort();
  const visible = applications.filter((application) => (page !== 'favorites' || favorites.includes(application.id))
    && (category === 'all' || application.category === category)
    && `${application.name} ${application.description} ${application.category}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((first, second) => sort === 'status'
      ? Number(second.health.state === 'online') - Number(first.health.state === 'online') || first.name.localeCompare(second.name)
      : first.name.localeCompare(second.name));
  const accountPage = page === 'account' || page === 'users';
  const title = page === 'account' ? 'Account settings' : page === 'users' ? 'User administration' : page === 'services' ? 'Service overview' : page === 'favorites' ? 'Your favorites' : 'Application library';

  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="topbar"><div className="topbar-inner">
      <a className="brand" href="#applications" aria-label="ssPortal home"><span className="brand-mark"><Layers3 size={23} strokeWidth={1.7} /></span>ssPortal<span className="brand-separator" /><span className="workspace-label">Workspace</span></a>
      {user && <nav aria-label="Main navigation">{pages.filter((entry) => entry.id !== 'users' || user.role === 'admin').map(({ id, name, Icon }) => <a key={id} href={`#${id}`} aria-current={page === id ? 'page' : undefined}>
        <Icon size={17} /><span>{name}</span>{id === 'favorites' && favorites.length > 0 && <small>{applications.filter((application) => favorites.includes(application.id)).length}</small>}
      </a>)}</nav>}
      <div className="header-actions">{user && <span className="signed-user-name" title={user.name}>{user.name}</span>}
        {user && <a className="icon-button" href="#account" aria-label="Account settings" title="Account settings" aria-current={page === 'account' ? 'page' : undefined}><UserRound size={19} /></a>}
        <IconButton label="Appearance settings" onClick={() => setAppearance(true)}><Palette size={20} /></IconButton>
        {user && <IconButton label="Sign out" disabled={auth.signingOut} onClick={() => void auth.signOut()}><LogOut size={19} /></IconButton>}
      </div>
    </div></header>

    {auth.loading ? <main id="main"><div className="loading-state" role="status">Connecting to your workspace...</div></main> : !user ? <AuthenticationScreen /> : <main id="main" tabIndex={-1}>
      <div className="breadcrumb"><span>WORKSPACE</span><ChevronRight size={12} /><span>{accountPage ? page.toUpperCase() : page === 'services' ? 'SERVICES' : page === 'favorites' ? 'FAVORITES' : 'OVERVIEW'}</span></div>
      <section className="page-heading"><div><h1 id="page-title">{title}<span className="heading-dot">.</span></h1>
        <p>{accountPage ? `${user.name} / ${user.role === 'admin' ? 'Administrator' : 'Member'}` : page === 'services' ? 'Runtime availability and response times' : page === 'favorites' ? `${favorites.filter((id) => applications.some((application) => application.id === id)).length} pinned applications` : 'Home, history, and everything in between.'}</p></div>
        {!accountPage && <div className="heading-actions"><span className="updated-label">{refreshing ? 'Checking services' : overview ? `Checked ${new Date(overview.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Awaiting connection'}</span>
          <IconButton label="Refresh status" onClick={() => setRefreshKey((value) => value + 1)} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spin' : ''} /></IconButton></div>}
      </section>

      {storageError && <div role="alert" className="notice"><CircleAlert size={18} />Browser storage is unavailable. Preferences will not persist after closing this page.</div>}
      {auth.error && <div role="alert" className="notice"><CircleAlert size={18} />{auth.error}<button className="text-button" type="button" onClick={() => void auth.refresh()}>Retry connection</button></div>}
      {error && <div role="alert" className="notice"><CircleAlert size={18} /><span>{error} Previous status is no longer current.</span>
        <button type="button" className="text-button" onClick={() => setRefreshKey((value) => value + 1)} disabled={refreshing}><RefreshCw size={15} />Retry</button></div>}

      {accountPage ? (page === 'account' ? <AccountSettings /> : <UserAdministration />) : <>{page !== 'applications' && <section className="metrics" aria-label="Workspace summary">
        <div className="metric"><span className="metric-label"><LayoutGrid size={15} />Applications</span><strong>{overview ? String(applications.length).padStart(2, '0') : '--'}</strong></div>
        <div className="metric"><span className="metric-label"><Activity size={15} />Available</span><strong className={online > 0 ? 'available-count' : ''}>{overview ? String(online).padStart(2, '0') : '--'}<span className="metric-unit">/ {applications.length}</span></strong></div>
        <div className="metric"><span className="metric-label"><Folder size={15} />Categories</span><strong>{overview ? String(categories.length).padStart(2, '0') : '--'}</strong></div>
        <div className="metric host-metric"><span className="metric-label"><Globe2 size={15} />Hostname</span><strong title={location.host}>{location.host}</strong><span className="host-caption">Single origin</span></div>
      </section>}

      {page !== 'services' ? <>
        <section className="applications-section" aria-labelledby={page === 'favorites' ? 'applications-heading' : 'page-title'}>
          {page === 'favorites' && <div className="section-heading"><h2 id="applications-heading"><span className="section-index">01</span>Pinned applications<span className="count-label">{visible.length}</span></h2></div>}
          <div className="library-toolbar"><label className="search-field"><Search size={18} /><input type="search" aria-label="Search applications" placeholder="Search applications..." value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
            {query && <IconButton label="Clear search" onClick={() => setQuery('')}><X size={15} /></IconButton>}</label>
            <label className="filter-field"><Folder size={16} /><select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.currentTarget.value)}><option value="all">All categories</option>{categories.map((name) => <option key={name}>{name}</option>)}</select></label>
            <label className="filter-field sort-field"><ArrowDownAZ size={17} /><select aria-label="Sort applications" value={sort} onChange={(event) => setSort(event.currentTarget.value)}><option value="name">Name</option><option value="status">Availability</option></select></label>
            <div className="view-control" aria-label="Application layout">
              <button type="button" aria-label="Grid view" title="Grid view" aria-pressed={preferences.view === 'grid'} onClick={() => updatePreferences({ ...preferences, view: 'grid' })}><Grid2X2 size={17} /></button>
              <button type="button" aria-label="List view" title="List view" aria-pressed={preferences.view === 'list'} onClick={() => updatePreferences({ ...preferences, view: 'list' })}><List size={18} /></button>
            </div>
          </div>
          {!overview && refreshing ? <div className="loading-state" role="status"><RefreshCw className="spin" size={22} />Loading applications</div>
            : visible.length === 0 ? <div className="empty-state"><Search size={28} /><h3>{query || category !== 'all' ? 'No matching applications' : page === 'favorites' ? 'No favorites yet' : 'No applications available'}</h3>
              {(query || category !== 'all') && <button className="text-button" type="button" onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters<ArrowRight size={16} /></button>}
              {page === 'favorites' && !query && <a className="text-button" href="#applications">Browse applications<ArrowRight size={16} /></a>}</div>
              : <div className={`application-grid ${preferences.view === 'list' ? 'list-layout' : ''}`}>{visible.map((application) => <article className={`app-card tone-${application.color}`} key={application.id}>
                <div className="card-heading"><AppIcon application={application} /><div className="app-title"><h3>{application.name}</h3><span>{application.category}</span></div>
                  <IconButton label={`Details for ${application.name}`} onClick={() => setDetails(application)}><Info size={18} /></IconButton></div>
                <p className="app-description">{application.description}</p>
                <div className="card-status"><Status health={application.health} /><code>{application.path}</code></div>
                <div className="card-footer"><div className="card-tools"><IconButton label={`${favorites.includes(application.id) ? 'Unpin' : 'Pin'} ${application.name}`} active={favorites.includes(application.id)} onClick={() => toggleFavorite(application)}>
                  <Star size={18} fill={favorites.includes(application.id) ? 'currentColor' : 'none'} /></IconButton><span>{favorites.includes(application.id) ? 'Pinned' : application.runtime.split(' / ')[0]}</span></div>
                  <a className="launch-link" href={application.path} target={preferences.newTab ? '_blank' : undefined} rel="noopener noreferrer" aria-label={`Open ${application.name}`}>Open app<ArrowUpRight size={17} /></a></div>
              </article>)}</div>}
        </section>
      </> : <section className="services-section" aria-labelledby="services-heading"><div className="section-heading"><h2 id="services-heading"><span className="section-index">01</span>Application services</h2><span className="muted">{online} of {applications.length} reachable</span></div>
        {!overview && refreshing ? <div className="loading-state" role="status">Checking services...</div> : <ServiceTable applications={applications} newTab={preferences.newTab} />}
        <div className="runtime-details"><div><Server size={18} /><span>Portal API</span><code>/api/portal/</code></div><div><span>Uptime</span><strong>{overview ? `${Math.floor(overview.server.uptime / 60)} min` : 'N/A'}</strong></div><div><span>Portal memory</span><strong>{overview ? `${overview.server.memoryMb} MB` : 'N/A'}</strong></div></div>
      </section>}</>}

      <footer className="page-footer"><span><Layers3 size={15} />ssPortal<span className="footer-version">v{overview?.server.version ?? '1.0.0'}</span></span>
        <span><span className={`status-dot ${error ? 'connection-error' : ''}`} />{error ? 'Connection interrupted' : overview ? 'Portal connected' : 'Connecting'}</span></footer>
    </main>}
    {appearance && <Appearance preferences={preferences} update={updatePreferences} close={() => setAppearance(false)} />}
    {user && details && <Modal title={details.name} onClose={() => setDetails(null)}><div className="details-intro"><AppIcon application={details} /><p>{details.description}</p></div>
      <dl className="details-list"><div><dt>Application path</dt><dd><code>{details.path}</code></dd></div>
        {details.apiPath && <div><dt>API path</dt><dd><code>{details.apiPath}</code></dd></div>}
        <div><dt>Runtime</dt><dd>{details.runtime}</dd></div><div><dt>Repository</dt><dd><code>{details.source}</code></dd></div>
        <div><dt>Availability</dt><dd><Status health={applications.find((application) => application.id === details.id)?.health ?? details.health} /></dd></div></dl>
      <div className="modal-footer"><button className="text-button" type="button" onClick={() => toggleFavorite(details)}><Star size={16} />{favorites.includes(details.id) ? 'Unpin application' : 'Pin application'}</button>
        <a className="primary-button" href={details.path} target={preferences.newTab ? '_blank' : undefined} rel="noopener noreferrer">Open {details.name}<ArrowUpRight size={17} /></a></div>
    </Modal>}
  </div>;
}