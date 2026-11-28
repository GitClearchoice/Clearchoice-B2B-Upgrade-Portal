import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useErrorBoundary, useState } from 'preact/hooks';

// The app's backend (Render web service). Keep in step with application_url in shopify.app.toml.
const APP_URL = 'https://clearchoice-b2b.onrender.com';
const SHOW_SITES = 50;

export default async () => {
  render(<Safe />, document.body);
};

function Safe() {
  const [err, reset] = useErrorBoundary((e) => console.error('Site managers:', e));
  if (err) {
    return (
      <s-page heading="Site managers">
        <s-banner tone="critical">Sorry, something went wrong on this page: {String(err && err.message ? err.message : err)}</s-banner>
        <s-button variant="secondary" onClick={reset}>Try again</s-button>
      </s-page>
    );
  }
  return <SiteManagers />;
}

async function api(method, body) {
  const token = await shopify.sessionToken.get();
  const res = await fetch(`${APP_URL}/customer/team`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

const roleLabel = (r) => (r === 'admin' ? 'Location admin' : 'Ordering only');

function SiteManagers() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // null | { mode: 'add' } | { mode: 'edit', person }

  function load() {
    return api('GET').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); }, []);

  if (!data) {
    return (
      <s-page heading="Site managers">
        {error ? <s-banner tone="critical">{error}</s-banner> : <s-text color="subdued">Loading…</s-text>}
      </s-page>
    );
  }
  if (!data.trade) return <s-page heading="Site managers"><s-text>This page is for trade customers.</s-text></s-page>;
  if (!data.isAdmin) {
    return (
      <s-page heading="Site managers" subheading={data.company}>
        <s-banner>Only your head-office admin can manage who orders for your sites.</s-banner>
      </s-page>
    );
  }

  function done(msg) {
    setEditing(null);
    setNotice(msg);
    setError('');
    load();
  }

  return (
    <s-page heading="Site managers" subheading={data.company}>
      <s-stack direction="block" gap="large">
        {error && <s-banner tone="critical">{error}</s-banner>}
        {notice && <s-banner tone="success">{notice}</s-banner>}
        <s-section heading="Who can order for your sites">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Give site managers access to the sites they look after. "Ordering only" can order for those sites; "Location admin" can also
              manage them. They log in with their email address and see your trade prices.
            </s-text>
            {editing ? (
              <PersonForm
                key={editing.mode === 'edit' ? editing.person.id : 'new'}
                mode={editing.mode}
                person={editing.person}
                sites={data.sites}
                onCancel={() => setEditing(null)}
                onDone={done}
                onError={setError}
              />
            ) : (
              <s-stack direction="inline" gap="base" justifyContent="end">
                <s-button variant="primary" onClick={() => { setNotice(''); setEditing({ mode: 'add' }); }}>Add site manager</s-button>
              </s-stack>
            )}
            {data.people.map((p) => (
              <Person key={p.id} person={p} disabled={!!editing} onEdit={() => { setNotice(''); setEditing({ mode: 'edit', person: p }); }} onDone={done} onError={setError} />
            ))}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function Person({ person: p, disabled, onEdit, onDone, onError }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try { const r = await api('POST', { action: 'remove', contactId: p.id }); onDone(r.message); }
    catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }
  const siteText = p.isYou
    ? 'All sites'
    : p.sites.length
      ? `${p.sites.length} site${p.sites.length === 1 ? '' : 's'}: ${p.sites.slice(0, 4).map((s) => s.name).join(', ')}${p.sites.length > 4 ? ` and ${p.sites.length - 4} more` : ''}`
      : 'No sites';
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{p.name}{p.isYou ? ' (you)' : ''}</s-text>
          {p.email && <s-text color="subdued">{p.email}</s-text>}
          <s-text>{p.isYou ? 'Head-office admin' : p.isMainContact ? 'Main contact (managed by Clearchoice)' : roleLabel(p.role)} · {siteText}</s-text>
        </s-stack>
        {!p.locked && !confirm && (
          <s-stack direction="inline" gap="small-200">
            <s-button variant="secondary" disabled={disabled} onClick={onEdit}>Edit</s-button>
            <s-button variant="secondary" tone="critical" disabled={disabled} onClick={() => setConfirm(true)}>Remove</s-button>
          </s-stack>
        )}
        {p.locked && <s-text />}
      </s-grid>
      {confirm && (
        <s-stack direction="block" gap="base">
          <s-banner tone="warning">Remove {p.name}? They'll no longer be able to order for your company. Their past orders stay in your history.</s-banner>
          <s-stack direction="inline" gap="base">
            <s-button tone="critical" loading={busy} onClick={remove}>Remove</s-button>
            <s-button variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</s-button>
          </s-stack>
        </s-stack>
      )}
    </s-box>
  );
}

function PersonForm({ mode, person, sites, onCancel, onDone, onError }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(person ? person.role : 'ordering');
  const [chosen, setChosen] = useState(() => new Set(person ? person.sites.map((s) => s.id) : []));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sites.filter((s) => words.every((w) => s.name.toLowerCase().includes(w)));

  function toggle(id, on) {
    const next = new Set(chosen);
    if (on) next.add(id); else next.delete(id);
    setChosen(next);
  }
  function selectShown(on) {
    const next = new Set(chosen);
    matches.slice(0, SHOW_SITES).forEach((s) => (on ? next.add(s.id) : next.delete(s.id)));
    setChosen(next);
  }

  async function save() {
    setBusy(true);
    try {
      const r = mode === 'add'
        ? await api('POST', { action: 'add', firstName, lastName, email, role, sites: [...chosen] })
        : await api('POST', { action: 'update', contactId: person.id, role, sites: [...chosen] });
      onDone(r.message);
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-heading>{mode === 'add' ? 'Add site manager' : `Edit ${person.name}`}</s-heading>
        {mode === 'add' && (
          <>
            <s-text-field label="First name" value={firstName} onInput={(e) => setFirstName(e.currentTarget.value)} />
            <s-text-field label="Last name" value={lastName} onInput={(e) => setLastName(e.currentTarget.value)} />
            <s-email-field label="Email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          </>
        )}
        <s-select label="Access" value={role} onChange={(e) => setRole(e.currentTarget.value)}>
          <s-option value="ordering">Ordering only: can order for these sites</s-option>
          <s-option value="admin">Location admin: can order and manage these sites</s-option>
        </s-select>
        <s-text type="strong">Sites ({chosen.size} chosen)</s-text>
        {sites.length > 8 && <s-text-field label="Search sites" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />}
        {/* Select all / Clear, then (after a gap) Save and Cancel, so they're reachable above a long site list. */}
        <s-stack direction="inline" gap="large" alignItems="center">
          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" onClick={() => selectShown(true)}>Select all shown</s-button>
            <s-button variant="secondary" onClick={() => selectShown(false)}>Clear shown</s-button>
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" loading={busy} onClick={save}>{mode === 'add' ? 'Add and email them' : 'Save changes'}</s-button>
            <s-button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</s-button>
          </s-stack>
        </s-stack>
        <s-stack direction="block" gap="small-200">
          {matches.slice(0, SHOW_SITES).map((s) => (
            <s-checkbox key={s.id} label={s.name} checked={chosen.has(s.id)} onChange={(e) => toggle(s.id, e.currentTarget.checked)} />
          ))}
          {matches.length > SHOW_SITES && <s-text color="subdued">Showing {SHOW_SITES} of {matches.length}. Search to find others.</s-text>}
          {!matches.length && <s-text color="subdued">No sites match your search.</s-text>}
        </s-stack>
      </s-stack>
    </s-box>
  );
}
