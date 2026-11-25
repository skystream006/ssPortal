import { useEffect, useState } from 'preact/hooks';
import { Check, CircleAlert, KeyRound, LogOut, Pencil, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, UserCheck, Users, UserX } from 'lucide-preact';
import { api, errorMessage, registerPasskey, useAuth } from './auth';
import type { User } from './auth';
import { IconButton, Modal } from './components';

type Passkey = { id: string; name: string; transports: string[]; createdAt: number; lastUsedAt: number | null };
const date = (timestamp: number) => new Date(timestamp).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const roleName = (role: User['role']) => role === 'admin' ? 'Administrator' : 'Member';

export function AccountSettings() {
  const auth = useAuth();
  const user = auth.user!;
  const [name, setName] = useState(user.name);
  const [keyName, setKeyName] = useState('');
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [dialogError, setDialogError] = useState('');

  async function loadKeys() {
    setLoading(true);
    try { setKeys((await api<{ passkeys: Passkey[] }>('/auth/passkeys')).passkeys); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { setName(user.name); }, [user.name]);
  useEffect(() => { void loadKeys(); }, [user.credentialCount]);

  async function saveName() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) });
      auth.acceptUser(result.user);
      setMessage('Username saved.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function addKey() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await registerPasskey('/auth/passkeys', { name: keyName });
      auth.acceptUser(result.user);
      setKeyName('');
      setMessage('Passkey added.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    if (!removing || busy) return;
    setBusy(true); setDialogError(''); setMessage('');
    try {
      const result = await api<{ user: User; passkeys: Passkey[] }>(`/auth/passkeys/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
      auth.acceptUser(result.user);
      setKeys(result.passkeys);
      setRemoving(null);
      setMessage('Passkey removed. Other sessions have been signed out.');
    } catch (failure) { setDialogError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="account-sections">
    {error && <div className="notice" role="alert"><CircleAlert size={18} />{error}</div>}
    {message && <div className="notice success" role="status"><Check size={18} />{message}</div>}
    <section className="account-section" aria-labelledby="profile-heading"><div className="section-heading"><h2 id="profile-heading"><span className="section-index">01</span>Profile</h2><span className="role-label"><ShieldCheck size={15} />{roleName(user.role)}</span></div>
      <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
        <label className="account-field"><span>Username</span><input aria-label="Username" autoComplete="username" required minLength={2} maxLength={64} value={name} onInput={(event) => setName(event.currentTarget.value)} disabled={busy} /></label>
        <button className="primary-button" type="submit" disabled={busy || name.trim() === user.name}><Save size={16} />Save username</button>
      </form>
      <p className="account-created">Account created {date(user.createdAt)}</p>
    </section>
    <section className="account-section" aria-labelledby="passkeys-heading"><div className="section-heading"><h2 id="passkeys-heading"><span className="section-index">02</span>Passkeys<span className="count-label">{user.credentialCount}</span></h2>
      <IconButton label="Refresh passkeys" disabled={busy || loading} onClick={() => void loadKeys()}><RefreshCw size={17} className={loading ? 'spin' : ''} /></IconButton></div>
      <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void addKey(); }}>
        <label className="account-field"><span>New passkey name</span><input aria-label="New passkey name" required maxLength={64} placeholder="Laptop, phone, or security key" value={keyName} onInput={(event) => setKeyName(event.currentTarget.value)} disabled={busy} /></label>
        <button className="primary-button" type="submit" disabled={busy || !keyName.trim() || keys.length >= 20}><Plus size={17} />Add passkey</button>
      </form>
      <ul className="passkey-list" aria-label="Registered passkeys">{keys.map((key) => <li key={key.id}><span className="key-symbol"><KeyRound size={20} /></span>
        <div className="key-description"><strong>{key.name}</strong><small>Added {date(key.createdAt)}<span>Last used {key.lastUsedAt ? date(key.lastUsedAt) : 'never'}</span></small></div>
        <IconButton label={`Remove ${key.name}`} disabled={busy || keys.length <= 1} className="danger-icon" onClick={() => { setRemoving(key); setDialogError(''); }}><Trash2 size={17} /></IconButton>
      </li>)}</ul>
    </section>
    {removing && <Modal title="Remove passkey?" onClose={() => { if (!busy) setRemoving(null); }}>
      <p className="confirmation-copy">Remove <strong>{removing.name}</strong>? This key will no longer work, and other portal sessions will be signed out.</p>
      {dialogError && <p className="notice" role="alert">{dialogError}</p>}
      <div className="modal-footer"><button className="text-button" type="button" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void removeKey()}><Trash2 size={16} />Remove passkey</button></div>
    </Modal>}
  </div>;
}

type Confirmation = { user: User; action: 'delete' | 'revoke' | 'sessions' };

export function UserAdministration() {
  const auth = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<User | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [dialogError, setDialogError] = useState('');

  async function loadUsers() {
    setLoading(true);
    try { setUsers((await api<{ users: User[] }>('/admin/users')).users); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (auth.user?.role === 'admin') void loadUsers(); }, [auth.user?.role]);

  async function approve(user: User) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
      await loadUsers();
      setMessage(`${user.name} approved.`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function saveUser() {
    if (!editing || busy) return;
    setBusy(true); setDialogError(''); setMessage('');
    try {
      await api(`/admin/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name: editing.name, role: editing.role, status: editing.status }) });
      const self = editing.id === auth.user?.id;
      setEditing(null);
      if (self) await auth.refresh();
      await loadUsers();
      setMessage('User updated. Access changes sign out existing sessions.');
    } catch (failure) { setDialogError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function confirmAction() {
    if (!confirming || busy) return;
    setBusy(true); setDialogError(''); setMessage('');
    try {
      const url = `/admin/users/${confirming.user.id}`;
      if (confirming.action === 'delete') await api(url, { method: 'DELETE' });
      else if (confirming.action === 'revoke') await api(url, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) });
      else await api(`${url}/revoke-sessions`, { method: 'POST', body: '{}' });
      setMessage(confirming.action === 'delete' ? 'Portal account deleted.' : confirming.action === 'revoke' ? 'Access revoked and sessions signed out.' : 'Sessions signed out.');
      setConfirming(null);
      await loadUsers();
    } catch (failure) { setDialogError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  if (auth.user?.role !== 'admin') return <div className="notice" role="alert"><ShieldCheck size={18} />Administrator access is required.</div>;
  const visible = users.filter((user) => (filter === 'all' || user.status === filter) && user.name.toLowerCase().includes(query.trim().toLowerCase()));
  const approvedAdmins = users.filter((user) => user.role === 'admin' && user.status === 'approved').length;

  return <section className="user-administration" aria-labelledby="users-heading">
    <div className="section-heading"><h2 id="users-heading"><Users size={18} />Portal users<span className="count-label">{users.length}</span></h2>
      <IconButton label="Refresh users" onClick={() => void loadUsers()} disabled={loading || busy}><RefreshCw size={18} className={loading ? 'spin' : ''} /></IconButton></div>
    {error && <div className="notice" role="alert"><CircleAlert size={18} />{error}</div>}
    {message && <div className="notice success" role="status"><Check size={18} />{message}</div>}
    <div className="user-counts"><span><strong>{users.filter((user) => user.status === 'pending').length}</strong> pending</span><span><strong>{users.filter((user) => user.status === 'approved').length}</strong> approved</span><span><strong>{users.filter((user) => user.status === 'revoked').length}</strong> revoked</span></div>
    <div className="library-toolbar"><label className="search-field"><Search size={18} /><input type="search" aria-label="Search users" placeholder="Search users..." value={query} onInput={(event) => setQuery(event.currentTarget.value)} /></label>
      <label className="filter-field"><ShieldCheck size={16} /><select aria-label="Filter users by access" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
        <option value="all">All access states</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="revoked">Revoked</option></select></label></div>
    <div className="table-scroll"><table className="service-table users-table"><thead><tr><th>Username</th><th>Role</th><th>Access</th><th>Passkeys</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>{visible.map((user) => <tr key={user.id}>
        <td><strong>{user.name}</strong>{user.id === auth.user?.id && <small className="self-label">You</small>}</td><td>{roleName(user.role)}</td>
        <td><span className={`access-badge access-${user.status}`}>{user.status}</span></td><td>{user.credentialCount}</td><td className="muted">{date(user.createdAt)}</td>
        <td><div className="user-actions">
          {user.status !== 'approved' && <IconButton label={`Approve ${user.name}`} disabled={busy} onClick={() => void approve(user)}><UserCheck size={18} /></IconButton>}
          <IconButton label={`Edit ${user.name}`} disabled={busy} onClick={() => { setEditing({ ...user }); setDialogError(''); }}><Pencil size={17} /></IconButton>
          {user.status === 'approved' && user.id !== auth.user?.id && <>
            <IconButton label={`Sign out ${user.name} everywhere`} disabled={busy} onClick={() => { setConfirming({ user, action: 'sessions' }); setDialogError(''); }}><LogOut size={17} /></IconButton>
            <IconButton label={`Revoke ${user.name}`} disabled={busy} onClick={() => { setConfirming({ user, action: 'revoke' }); setDialogError(''); }}><UserX size={18} /></IconButton>
          </>}
          <IconButton label={`Delete ${user.name}`} disabled={busy || user.id === auth.user?.id} className="danger-icon" onClick={() => { setConfirming({ user, action: 'delete' }); setDialogError(''); }}><Trash2 size={17} /></IconButton>
        </div></td>
      </tr>)}</tbody></table></div>
    {!loading && visible.length === 0 && <div className="user-empty">No matching users.</div>}
    {editing && <Modal title={`Edit ${editing.name}`} onClose={() => { if (!busy) setEditing(null); }}>
      <form className="user-edit-form" onSubmit={(event) => { event.preventDefault(); void saveUser(); }}>
        <label className="account-field"><span>Username</span><input aria-label="Username" required minLength={2} maxLength={64} value={editing.name} onInput={(event) => setEditing({ ...editing, name: event.currentTarget.value })} disabled={busy} /></label>
        <div className="account-field-pair"><label className="account-field"><span>Role</span><select aria-label="Role" value={editing.role} disabled={busy || (editing.id === auth.user?.id && approvedAdmins <= 1)} onChange={(event) => setEditing({ ...editing, role: event.currentTarget.value as User['role'] })}><option value="user">Member</option><option value="admin">Administrator</option></select></label>
          <label className="account-field"><span>Access</span><select aria-label="Access" value={editing.status} disabled={busy || editing.id === auth.user?.id} onChange={(event) => setEditing({ ...editing, status: event.currentTarget.value as User['status'] })}><option value="pending">Pending</option><option value="approved">Approved</option><option value="revoked">Revoked</option></select></label></div>
        {dialogError && <p className="notice" role="alert">{dialogError}</p>}
        <div className="modal-footer"><button className="text-button" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" type="submit" disabled={busy}><Save size={16} />Save user</button></div>
      </form>
    </Modal>}
    {confirming && <Modal title={confirming.action === 'delete' ? 'Delete portal account?' : confirming.action === 'revoke' ? 'Revoke access?' : 'Sign out all sessions?'} onClose={() => { if (!busy) setConfirming(null); }}>
      <p className="confirmation-copy"><strong>{confirming.user.name}</strong><br />{confirming.action === 'delete'
        ? 'This permanently removes the portal account and its passkeys. Accounts inside Grocy and webtrees are not deleted.'
        : confirming.action === 'revoke' ? 'This user will lose portal and application access immediately.' : 'This user will need a passkey to sign in again.'}</p>
      {dialogError && <p className="notice" role="alert">{dialogError}</p>}
      <div className="modal-footer"><button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={() => void confirmAction()}>
        {confirming.action === 'delete' ? <Trash2 size={16} /> : <UserX size={16} />}{confirming.action === 'delete' ? 'Delete account' : confirming.action === 'revoke' ? 'Revoke access' : 'Sign out sessions'}</button></div>
    </Modal>}
  </section>;
}