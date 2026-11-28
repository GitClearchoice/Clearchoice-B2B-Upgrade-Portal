import '@shopify/ui-extensions/preact';
import { Fragment, render } from 'preact';
import { useEffect, useErrorBoundary, useState } from 'preact/hooks';
import { SiteManagers } from './Managers.jsx';

// The app's backend (Render web service). Keep in step with application_url in shopify.app.toml.
const APP_URL = 'https://clearchoice-b2b.onrender.com';
const PAGE_SIZE = 25;

export default async () => {
  render(<Safe />, document.body);
};

// If anything on the page fails, show the error instead of Shopify's "problem loading this page".
function Safe() {
  const [err, reset] = useErrorBoundary((e) => console.error('Site budgets:', e));
  if (err) {
    return (
      <s-page heading="Site budgets">
        <s-banner tone="critical">Sorry, something went wrong on this page: {String(err && err.message ? err.message : err)}</s-banner>
        <s-button variant="secondary" onClick={reset}>Try again</s-button>
      </s-page>
    );
  }
  return <Root />;
}

// Two views on one page: Site budgets and Site managers. The "Site Managers" menu item links to this
// page's sub-path /managers (Shopify drops query strings on page links; a second full-page extension
// wouldn't load).
function currentUrl() {
  try {
    return (shopify.navigation && shopify.navigation.currentEntry && shopify.navigation.currentEntry.url) || '';
  } catch (e) {
    return '';
  }
}
const viewFor = (url) => (/managers/i.test(url) ? 'managers' : 'budgets');

function Root() {
  const [view, setView] = useState(() => viewFor(currentUrl()));
  useEffect(() => {
    if (!shopify.navigation || !shopify.navigation.addEventListener) return undefined;
    const onChange = () => setView(viewFor(currentUrl()));
    shopify.navigation.addEventListener('currententrychange', onChange);
    return () => shopify.navigation.removeEventListener('currententrychange', onChange);
  }, []);
  const tabs = (
    <s-stack direction="inline" gap="base">
      <s-button variant={view === 'budgets' ? 'primary' : 'secondary'} onClick={() => setView('budgets')}>Site budgets</s-button>
      <s-button variant={view === 'managers' ? 'primary' : 'secondary'} onClick={() => setView('managers')}>Site managers</s-button>
    </s-stack>
  );
  return view === 'managers' ? <SiteManagers tabs={tabs} /> : <SiteBudgets tabs={tabs} />;
}

const money = (n) => '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

async function api(method, path, body) {
  const token = await shopify.sessionToken.get();
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function SiteBudgets({ tabs }) {
  const [params, setParams] = useState({ quarter: '', fy: '', site: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  function load(next = params) {
    setLoading(true);
    const q = [['quarter', next.quarter], ['fy', next.fy], ['site', next.site]]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return api('GET', `/customer/budgets${q ? `?${q}` : ''}`)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function change(patch) {
    const next = { ...params, ...patch };
    setParams(next);
    load(next);
  }

  if (!data) {
    return (
      <s-page heading="Site budgets">
        {tabs}
        {error ? <s-banner tone="critical">{error}</s-banner> : <s-text color="subdued">Loading…</s-text>}
      </s-page>
    );
  }
  if (!data.trade) {
    return <s-page heading="Site budgets"><s-text>This page is for trade customers.</s-text></s-page>;
  }
  if (!data.isAdmin) {
    return (
      <s-page heading="Site budgets" subheading={data.company}>
        <s-banner>Only your head-office admin can see and change site budgets.</s-banner>
      </s-page>
    );
  }

  return (
    <s-page heading="Site budgets" subheading={data.company}>
      <s-stack direction="block" gap="large">
        {tabs}
        {error && <s-banner tone="critical">{error}</s-banner>}
        {notice && <s-banner tone="success">{notice}</s-banner>}
        <Approvals items={data.approvals} />
        <Quarter data={data} loading={loading} onQuarter={(quarter) => change({ quarter })} onSaved={(msg) => { setNotice(msg); load(); }} onError={setError} />
        <Year data={data} loading={loading} onFy={(fy) => change({ fy })} onSite={(site) => change({ site })} />
        <Orders data={data} />
      </s-stack>
    </s-page>
  );
}

// One-line summary of a section with a Show / Hide link, so the page stays short (expand what you need).
function Toggle({ summary, open, onToggle, showLabel, hideLabel = 'Hide' }) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
      <s-text type="strong">{summary}</s-text>
      <s-link onClick={onToggle}>{open ? hideLabel : showLabel}</s-link>
    </s-grid>
  );
}

function Approvals({ items }) {
  if (!items.length) return null;
  return (
    <s-section heading={`Waiting for your approval (${items.length})`}>
      <s-stack direction="block" gap="base">
        {items.map((a) => (
          <s-box key={a.id} padding="base" border="base" borderRadius="base">
            {/* Details on the left, the Review order button on the right, centred against the three lines. */}
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{a.site}</s-text>
                <s-text color="subdued">{a.buyer} · {date(a.placed)} · PO {a.po}</s-text>
                <s-text>{money(a.goodsExGst)} ex GST</s-text>
              </s-stack>
              {a.reviewUrl ? <s-button href={a.reviewUrl} target="_blank" variant="primary">Review order</s-button> : <s-text />}
            </s-grid>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

function Quarter({ data, loading, onQuarter, onSaved, onError }) {
  const [open, setOpen] = useState(data.sites.length <= 5);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [busy, setBusy] = useState(false);

  // Import: the CSV is read here and sent to the app, which checks every row before saving any.
  async function onFile(event) {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await api('POST', '/customer/budgets', { action: 'import', csv });
      setImporting(false);
      const missing = r.unknown && r.unknown.length ? ` Not found: ${r.unknown.slice(0, 5).join(', ')}${r.unknown.length > 5 ? '…' : ''}.` : '';
      onSaved(`Imported budgets for ${r.updated} site${r.updated === 1 ? '' : 's'}.${missing}`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const [shown, setShown] = useState(PAGE_SIZE);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = data.sites.filter((s) => words.every((w) => `${s.name} ${s.code || ''}`.toLowerCase().includes(w)));
  return (
    <s-section heading={`Budgets: ${data.quarter.label}`}>
      <s-stack direction="block" gap="base">
        <Toggle
          summary={budgetSummary(data)}
          open={open}
          onToggle={() => setOpen(!open)}
          showLabel={`Show sites (${data.sites.length})`}
          hideLabel="Hide sites"
        />
        {open && (<>
        <s-stack direction="inline" gap="base" justifyContent="end">
          {data.budgetsExportUrl && <s-button href={data.budgetsExportUrl} target="_blank" variant="secondary">Export CSV</s-button>}
          <s-button variant="secondary" onClick={() => setImporting(!importing)}>{importing ? 'Cancel import' : 'Import CSV'}</s-button>
          <s-button variant="secondary" onClick={() => setRequesting(!requesting)}>{requesting ? 'Cancel request' : 'Request a new site'}</s-button>
        </s-stack>
        {requesting && <RequestSite onDone={(msg) => { setRequesting(false); onSaved(msg); }} onError={onError} />}
        <PendingRequests items={data.siteRequests || []} onDone={onSaved} onError={onError} />
        {importing && (
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text>Export first and use that file as the template. Change the amounts in Excel (keep the header row and the Site ID column), save as CSV, then choose it here. Blank cells remove that budget.</s-text>
              <s-drop-zone label="Budgets CSV" accept=".csv,text/csv" disabled={busy} onChange={onFile} />
              {busy && <s-text color="subdued">Importing…</s-text>}
            </s-stack>
          </s-box>
        )}
        <s-text color="subdued">Monthly budgets per site, goods only (ex GST and freight). Orders that would go over a site's budget come to you for approval.</s-text>
        <s-stack direction="inline" gap="base">
          <s-button variant="secondary" disabled={loading} onClick={() => onQuarter(data.quarter.prev)}>‹ Previous quarter</s-button>
          <s-button variant="secondary" disabled={loading} onClick={() => onQuarter(data.quarter.next)}>Next quarter ›</s-button>
        </s-stack>
        {data.sites.length > 5 && (
          <s-text-field label="Search sites" value={search} onInput={(e) => { setSearch(e.currentTarget.value); setShown(PAGE_SIZE); }} />
        )}
        {matches.slice(0, shown).map((s) => (
          <Site key={s.id} site={s} data={data} onSaved={onSaved} onError={onError} />
        ))}
        {matches.length > shown && (
          <s-button variant="secondary" onClick={() => setShown(shown + PAGE_SIZE)}>Show more sites ({matches.length - shown} more)</s-button>
        )}
        {!matches.length && <s-text color="subdued">No sites match your search.</s-text>}
        </>)}
      </s-stack>
    </s-section>
  );
}

// "Request a new site": emailed to Clearchoice to add in Unleashed; once the site appears in the portal the
// site code, budget and site managers chosen here are applied automatically.
const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

function RequestSite({ onDone, onError }) {
  const [f, setF] = useState({ siteName: '', address1: '', address2: '', suburb: '', state: 'NSW', postcode: '', siteCode: '', contactName: '', contactPhone: '', deliveryNotes: '', monthlyBudget: '' });
  const [people, setPeople] = useState([]);
  const [managers, setManagers] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('GET', '/customer/team').then((d) => setPeople((d.people || []).filter((p) => !p.locked))).catch(() => setPeople([]));
  }, []);
  const set = (k) => (e) => { const v = e.currentTarget.value; setF((prev) => ({ ...prev, [k]: v })); };
  function toggle(id, on) {
    const next = new Set(managers);
    if (on) next.add(id); else next.delete(id);
    setManagers(next);
  }
  async function send() {
    setBusy(true);
    try {
      const r = await api('POST', '/customer/budgets', { action: 'request-site', request: { ...f, managerIds: [...managers] } });
      onDone(r.message);
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  }
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-heading>Request a new site</s-heading>
        <s-text color="subdued">Clearchoice adds the site to your account (usually within a working day) and emails you when you can order for it.</s-text>
        <s-text-field label="Site name" value={f.siteName} onInput={set('siteName')} />
        <s-text-field label="Street address" value={f.address1} onInput={set('address1')} />
        <s-text-field label="Address line 2 (optional)" value={f.address2} onInput={set('address2')} />
        <s-grid gridTemplateColumns="1fr auto auto" gap="base">
          <s-text-field label="Suburb" value={f.suburb} onInput={set('suburb')} />
          <s-select label="State" value={f.state} onChange={set('state')}>
            {STATES.map((st) => <s-option key={st} value={st}>{st}</s-option>)}
          </s-select>
          <s-text-field label="Postcode" value={f.postcode} onInput={set('postcode')} maxLength={4} />
        </s-grid>
        <s-text-field label="Site code (your own reference, optional)" value={f.siteCode} onInput={set('siteCode')} />
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field label="Site contact (optional)" value={f.contactName} onInput={set('contactName')} />
          <s-text-field label="Contact phone (optional)" value={f.contactPhone} onInput={set('contactPhone')} />
        </s-grid>
        <s-text-area label="Delivery notes, e.g. dock, hours (optional)" value={f.deliveryNotes} onInput={set('deliveryNotes')} />
        <s-number-field label="Monthly budget, $ ex GST (optional)" min={0} step={1} value={f.monthlyBudget} onInput={set('monthlyBudget')} />
        {people.length > 0 && (
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">Site managers who should order for it (optional)</s-text>
            {people.map((p) => (
              <s-checkbox key={p.id} label={`${p.name}${p.email ? ` (${p.email})` : ''}`} checked={managers.has(p.id)} onChange={(e) => toggle(p.id, e.currentTarget.checked)} />
            ))}
          </s-stack>
        )}
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" loading={busy} onClick={send}>Send request</s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

function PendingRequests({ items, onDone, onError }) {
  if (!items.length) return null;
  async function cancel(id) {
    try {
      const r = await api('POST', '/customer/budgets', { action: 'cancel-request', requestId: id });
      onDone(r.message);
    } catch (e) { onError(e.message); }
  }
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">New sites requested</s-text>
      {items.map((r) => (
        <s-box key={r.id} padding="small-200" border="base" borderRadius="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">{r.siteName}</s-text>
              <s-text color="subdued">{r.address} · requested {date(r.requested)} by {r.requestedBy}</s-text>
              <s-text color="subdued">Waiting for Clearchoice to add it</s-text>
            </s-stack>
            <s-link onClick={() => cancel(r.id)}>Cancel</s-link>
          </s-grid>
        </s-box>
      ))}
    </s-stack>
  );
}

function budgetSummary(data) {
  const withBudget = data.sites.filter((s) => s.now.budget != null);
  const over = withBudget.filter((s) => s.now.ordered > s.now.budget).length;
  const ordered = data.sites.reduce((t, s) => t + s.now.ordered, 0);
  const budget = withBudget.reduce((t, s) => t + s.now.budget, 0);
  return `${data.sites.length} site${data.sites.length === 1 ? '' : 's'}${over ? ` · ${over} over budget` : ''} · ${money(ordered)}${budget ? ` of ${money(budget)}` : ''} ordered in ${data.thisMonth.label}`;
}

function Site({ site, data, onSaved, onError }) {
  const [mode, setMode] = useState(''); // '' | 'edit' | 'close'
  const [values, setValues] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const now = site.now;
  const over = now.budget != null && now.ordered > now.budget;

  const [code, setCode] = useState(site.code || '');
  function startEdit() {
    setCode(site.code || '');
    const v = { default: site.default ?? '' };
    data.quarter.months.forEach((m, i) => { v[m.key] = site.months[i] ?? ''; });
    setValues(v);
    setMode('edit');
  }
  async function save() {
    setBusy(true);
    try {
      const out = {};
      for (const [k, v] of Object.entries(values)) out[k] = v === '' || v === null ? null : Number(v);
      await api('POST', '/customer/budgets', { action: 'save', site: site.id, values: out, siteCode: code });
      setMode('');
      onSaved(`Budgets saved for ${site.name}.`);
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  }
  async function closeSite() {
    setBusy(true);
    try {
      await api('POST', '/customer/budgets', { action: 'close', site: site.id, reason });
      setMode('');
      onSaved(`${site.name} has been closed. Clearchoice has been told, and it's no longer available for ordering.`);
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  }

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        {/* Site details on the left; the two actions as small links on the right, lined up with the bottom lines. */}
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">{site.name}{site.code ? ` · ${site.code}` : ''}</s-text>
            {now.budget == null ? (
              <s-text color="subdued">{data.thisMonth.label}: no budget set · {money(now.ordered)} ordered</s-text>
            ) : (
              <>
                <s-text>{data.thisMonth.label}: {money(now.ordered)} of {money(now.budget)} ordered</s-text>
                <s-progress value={Math.min(now.ordered, now.budget)} max={now.budget || 1} tone={over ? 'critical' : 'auto'} accessibilityLabel="Budget used this month" />
                <s-paragraph>
                  <s-text type="strong" tone="critical">{over ? `Over by ${money(now.ordered - now.budget)}` : `${money(now.budget - now.ordered)} left`}</s-text>
                  {now.awaiting ? <s-text color="subdued">{` · ${money(now.awaiting)} waiting for approval`}</s-text> : null}
                </s-paragraph>
              </>
            )}
            {/* Labels in bold, amounts in the normal (black) text colour. */}
            <s-paragraph>
              <s-text type="strong">Every month:</s-text> <s-text color="base">{site.default == null ? 'not set' : money(site.default)}</s-text>
              {data.quarter.months.map((m, i) => (
                <Fragment key={m.key}>
                  {' · '}
                  <s-text type="strong">{m.label}:</s-text> <s-text color="base">{site.effective[i] == null ? '–' : money(site.effective[i])}</s-text>
                </Fragment>
              ))}
            </s-paragraph>
          </s-stack>
          {!mode ? (
            <s-stack direction="block" gap="small-200" alignItems="end">
              <s-link onClick={startEdit}>Edit budgets</s-link>
              <s-link onClick={() => setMode('close')}>We no longer use this site</s-link>
            </s-stack>
          ) : (
            <s-text />
          )}
        </s-grid>

        {mode === 'edit' && (
          <s-stack direction="block" gap="base">
            <s-text-field label="Site code (your own reference for this site, optional)" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
            <s-number-field label="Every month ($ ex GST)" min={0} step={1} value={values.default} onInput={(e) => setValues({ ...values, default: e.currentTarget.value })} />
            {data.quarter.months.map((m) => (
              <s-number-field key={m.key} label={`${m.label} only (blank = every month)`} min={0} step={1} value={values[m.key]} onInput={(e) => setValues({ ...values, [m.key]: e.currentTarget.value })} />
            ))}
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" loading={busy} onClick={save}>Save budgets</s-button>
              <s-button variant="secondary" disabled={busy} onClick={() => setMode('')}>Cancel</s-button>
            </s-stack>
          </s-stack>
        )}

        {mode === 'close' && (
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">Close {site.name}? It will no longer be available for ordering, and Clearchoice will be asked to mark it obsolete. Past orders stay in your history.</s-banner>
            <s-text-area label="Reason (optional)" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
            <s-stack direction="inline" gap="base">
              <s-button tone="critical" loading={busy} onClick={closeSite}>Close this site</s-button>
              <s-button variant="secondary" disabled={busy} onClick={() => setMode('')}>Cancel</s-button>
            </s-stack>
          </s-stack>
        )}

      </s-stack>
    </s-box>
  );
}

function SiteSelect({ data, onSite }) {
  return (
    <s-select label="Site" value={data.year.site ?? ''} onChange={(e) => onSite(e.currentTarget.value)}>
      <s-option value="">All sites</s-option>
      {data.sites.map((s) => <s-option key={s.id} value={s.id}>{s.name}</s-option>)}
    </s-select>
  );
}

function Year({ data, loading, onFy, onSite }) {
  const y = data.year;
  const [open, setOpen] = useState(true);
  return (
    <s-section heading={`Year summary: ${y.label}`}>
      <s-stack direction="block" gap="base">
        <Toggle summary={`${money(y.totals.budget)} budget · ${money(y.totals.ordered)} ordered`} open={open} onToggle={() => setOpen(!open)} showLabel="Show year" />
        {open && (<>
        <s-stack direction="inline" gap="base">
          <s-button variant="secondary" disabled={loading} onClick={() => onFy(y.prev)}>‹ Previous year</s-button>
          <s-button variant="secondary" disabled={loading} onClick={() => onFy(y.next)}>Next year ›</s-button>
        </s-stack>
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
          <SiteSelect data={data} onSite={onSite} />
          {data.yearExportUrl ? <s-button href={data.yearExportUrl} target="_blank" variant="secondary">Export report</s-button> : <s-text />}
        </s-grid>
        <s-grid gridTemplateColumns="1fr auto auto" gap="small-200">
          <s-text type="strong">Month</s-text>
          <s-text type="strong">Budget</s-text>
          <s-text type="strong">Ordered</s-text>
          {y.months.map((m) => [
            <s-text key={`${m.key}a`}>{m.label}</s-text>,
            <s-text key={`${m.key}b`}>{m.budget ? money(m.budget) : '–'}</s-text>,
            <s-text key={`${m.key}c`} tone={m.budget && m.ordered > m.budget ? 'critical' : 'auto'}>{money(m.ordered)}</s-text>,
          ])}
          <s-text type="strong">Total</s-text>
          <s-text type="strong">{money(y.totals.budget)}</s-text>
          <s-text type="strong">{money(y.totals.ordered)}</s-text>
        </s-grid>
        <s-text color="subdued">Budget counts sites that have one; ordered counts orders sent to Clearchoice (including approved ones). Goods ex GST.</s-text>
        </>)}
      </s-stack>
    </s-section>
  );
}

function Orders({ data }) {
  const [open, setOpen] = useState(false);
  const total = data.orders.reduce((t, o) => t + o.goodsExGst, 0);
  return (
    <s-section heading={`Order history: ${data.year.label}${data.year.site ? ` · ${data.sites.find((s) => s.id === data.year.site)?.name ?? ''}` : ''}`}>
      <s-stack direction="block" gap="base">
        <Toggle
          summary={`${data.orders.length}${data.orders.length === 200 ? '+' : ''} order${data.orders.length === 1 ? '' : 's'} · ${money(total)} ex GST`}
          open={open}
          onToggle={() => setOpen(!open)}
          showLabel="Show orders"
          hideLabel="Hide orders"
        />
        {data.exportUrl && <s-button href={data.exportUrl} target="_blank" variant="secondary">Download CSV</s-button>}
        {open && (<>
        {!data.orders.length && <s-text color="subdued">No trade orders in this period.</s-text>}
        {data.orders.map((o) => (
          <s-box key={o.id} padding="small-200" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">{date(o.placed)} · {money(o.goodsExGst)}</s-text>
              <s-text>{o.site}</s-text>
              <s-text color="subdued">{o.so || o.reference} · PO {o.po} · {o.buyer}</s-text>
              <s-text color="subdued">{o.status}</s-text>
            </s-stack>
          </s-box>
        ))}
        {data.orders.length === 200 && <s-text color="subdued">Showing the latest 200. Download the CSV for all of them.</s-text>}
        </>)}
      </s-stack>
    </s-section>
  );
}
