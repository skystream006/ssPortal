import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ArrowUpRight, CircleAlert, Clock3, Fingerprint, KeyRound, RefreshCw, ShieldCheck } from 'lucide-preact';

export type User = {
  id: string; name: string; role: 'admin' | 'user'; status: 'pending' | 'approved' | 'revoked';
  credentialCount: number; createdAt: number; updatedAt: number;
};
type AuthState = { user: User | null; setupRequired: boolean; registrationAllowed: boolean; origin: string; rpID: string };
type AuthContextValue = AuthState & { loading: boolean; error: string; signingOut: boolean; refresh: () => Promise<void>; acceptUser: (user: User) => void; signOut: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);

export class ApiError extends Error {
  constructor(message: string, public status: number, public code = '') { super(message); }
}

export async function api<T = void>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/portal${path}`, {
    ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('ssportal:session-expired'));
    throw new ApiError(body?.error ?? 'The request failed.', response.status, body?.code);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return 'The passkey request was cancelled or timed out. Please try again.';
    if (error.name === 'InvalidStateError') return 'This authenticator already has a passkey for this account.';
    if (error.name === 'NotSupportedError') return 'Passkeys are not supported by this browser or authenticator.';
    return error.message;
  }
  return 'The request could not be completed.';
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<AuthState>({ user: null, setupRequired: false, registrationAllowed: false, origin: location.origin, rpID: location.hostname });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const generation = useRef(0);

  async function refresh() {
    const version = ++generation.current;
    try {
      const next = await api<AuthState>('/auth/me');
      if (version === generation.current) { setState(next); setError(''); }
    } catch { if (version === generation.current) setError('Unable to connect to the account service.'); }
    finally { if (version === generation.current) setLoading(false); }
  }

  function clearUser() {
    generation.current += 1;
    setState((previous) => ({ ...previous, user: null }));
  }

  function acceptUser(user: User) {
    generation.current += 1;
    setState((previous) => ({ ...previous, user, setupRequired: false }));
    setError('');
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      clearUser();
      location.hash = 'applications';
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSigningOut(false); }
  }

  useEffect(() => {
    void refresh();
    const poll = () => { if (document.visibilityState === 'visible') void refresh(); };
    const interval = window.setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('ssportal:session-expired', clearUser);
    return () => {
      generation.current += 1;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('ssportal:session-expired', clearUser);
    };
  }, []);

  useEffect(() => {
    if (!loading && state.user) resumeApplication();
  }, [loading, state.user?.id]);

  return <AuthContext.Provider value={{ ...state, loading, error, signingOut, refresh, acceptUser, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required.');
  return context;
}

type RegistrationChallenge = { requestId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] };
type LoginChallenge = { requestId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };

export async function registerPasskey(path: string, body: Record<string, string>) {
  const challenge = await api<RegistrationChallenge>(`${path}/options`, { method: 'POST', body: JSON.stringify(body) });
  const response = await startRegistration({ optionsJSON: challenge.options });
  return api<{ user: User }>(`${path}/verify`, { method: 'POST', body: JSON.stringify({ requestId: challenge.requestId, response }) });
}

function resumeApplication() {
  const target = new URLSearchParams(location.search).get('returnTo');
  if (!target) return;
  history.replaceState(null, '', `/${location.hash}`);
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u001f]/.test(target)) return;
  const destination = new URL(target, location.origin);
  if (destination.origin === location.origin && !destination.pathname.startsWith('/api/')) location.assign(destination.href);
}

export function AuthenticationScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>(auth.setupRequired ? 'register' : 'login');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = isSecureContext && browserSupportsWebAuthn();
  const canonical = location.origin === auth.origin;

  useEffect(() => { if (auth.setupRequired) setMode('register'); }, [auth.setupRequired]);

  async function authenticate(action: typeof mode) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let result: { user: User };
      if (action === 'login') {
        const challenge = await api<LoginChallenge>('/auth/login/options', { method: 'POST', body: '{}' });
        const response = await startAuthentication({ optionsJSON: challenge.options });
        result = await api('/auth/login/verify', { method: 'POST', body: JSON.stringify({ requestId: challenge.requestId, response }) });
      } else {
        result = await registerPasskey(`/auth/${action}`, action === 'recover' ? { code } : { name, ...(auth.setupRequired ? { setupCode: code } : {}) });
      }
      if (result.user.status === 'approved') auth.acceptUser(result.user);
      else { setPending(result.user.name); setCode(''); }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  const title = pending ? 'Awaiting approval' : mode === 'recover' ? 'Recover your account' : auth.setupRequired ? 'Create administrator' : mode === 'register' ? 'Request access' : 'Sign in to ssPortal';
  return <main id="main" className="authentication-main" tabIndex={-1}>
    <section className="authentication-form" aria-labelledby="auth-title">
      <span className="auth-symbol">{pending ? <Clock3 size={30} /> : auth.setupRequired ? <ShieldCheck size={30} /> : <Fingerprint size={32} />}</span>
      <p className="eyebrow">YOUR WORKSPACE</p><h1 id="auth-title">{title}</h1>
      {!pending && !auth.setupRequired && <div className="auth-tabs" aria-label="Authentication mode">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); setCode(''); }}>Sign in</button>
        {auth.registrationAllowed && <button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(''); setCode(''); }}>Create account</button>}
      </div>}
      {!canonical && <div className="notice" role="alert"><CircleAlert size={18} /><span>Use the configured sign-in address.<a href={`${auth.origin}/${location.search}`} className="text-button">{auth.origin}<ArrowUpRight size={15} /></a></span></div>}
      {!supported && <div className="notice" role="alert"><CircleAlert size={18} />Passkeys require a supported browser and HTTPS, or localhost.</div>}
      {auth.error && <div className="notice" role="alert"><CircleAlert size={18} /><span>{auth.error}</span><button className="text-button" type="button" onClick={() => void auth.refresh()}>Retry</button></div>}
      {error && <div className="notice" role="alert"><CircleAlert size={18} />{error}</div>}
      {pending ? <div className="pending-access"><p><strong>{pending}</strong></p><span className="access-badge access-pending">Pending administrator approval</span>
        <button className="primary-button" type="button" disabled={busy || !supported || !canonical} onClick={() => void authenticate('login')}><Fingerprint size={19} />Check approval</button>
        <button className="text-button" type="button" onClick={() => { setPending(''); setMode('login'); setError(''); }}>Back to sign in</button>
      </div> : <form onSubmit={(event) => { event.preventDefault(); void authenticate(mode); }}>
        {mode === 'register' && <label className="account-field"><span>Username</span><input aria-label="Username" required minLength={2} maxLength={64} autoComplete="username" value={name} onInput={(event) => setName(event.currentTarget.value)} disabled={busy} /></label>}
        {(mode === 'recover' || (mode === 'register' && auth.setupRequired)) && <label className="account-field"><span>{mode === 'recover' ? 'Recovery code' : 'Server setup code'}</span>
          <input type="password" aria-label={mode === 'recover' ? 'Recovery code' : 'Server setup code'} required autoComplete="off" maxLength={100} value={code} onInput={(event) => setCode(event.currentTarget.value)} disabled={busy} /></label>}
        <button className="primary-button auth-submit" type="submit" disabled={busy || !supported || !canonical || Boolean(auth.error)}>
          {busy ? <RefreshCw size={19} className="spin" /> : <Fingerprint size={19} />}{busy ? 'Waiting for passkey' : mode === 'login' ? 'Sign in with passkey' : mode === 'recover' ? 'Create recovery passkey' : 'Create passkey'}
        </button>
        {!auth.setupRequired && mode !== 'recover' && <button className="text-button recovery-link" type="button" disabled={busy} onClick={() => { setMode('recover'); setError(''); }}><KeyRound size={15} />Recover account</button>}
      </form>}
    </section>
  </main>;
}