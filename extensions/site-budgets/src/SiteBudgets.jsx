import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// The app's backend (Render web service). Keep in step with application_url in shopify.app.toml.
const APP_URL = 'https://clearchoice-b2b.onrender.com';
const PAGE_SIZE = 25;

export default async () => {
  render(<SiteBudgets />, document.body);
};

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

function SiteBudgets() {
  const [params, setParams] = useState({ quarter: '', fy: '', site: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  function load(next = params) {
    setLoading(true);
    const q = new URLSearchParams();
    if (next.quarter) q.set('quarter', next.quarter);
    if (next.fy) q.set('fy', next.fy);
    if (next.site) q.set('site', next.site);
    return api('GET', `/customer/budgets?${q}`)
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

function Approvals({ items }) {
  if (!items.length) return null;
  return (
    <s-section heading={`Waiting for your approval (${items.length})`}>
      <s-stack direction="block" gap="base">
        {items.map((a) => (
          <s-box key={a.id} padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">{a.site}</s-text>
              <s-text color="subdued">{a.buyer} · {date(a.placed)} · PO {a.po}</s-text>
              <s-text>{money(a.goodsExGst)} ex GST</s-text>
              {a.reviewUrl && <s-button href={a.reviewUrl} target="_blank" variant="primary">Review order</s-button>}
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

function Quarter({ data, loading, onQuarter, onSaved, onError }) {
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = data.sites.filter((s) => words.every((w) => s.name.toLowerCase().includes(w)));
  return (
    <s-section heading={`Budgets: ${data.quarter.label}`}>
      <s-stack direction="block" gap="base">
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
      </s-stack>
    </s-section>
  );
}

function Site({ site, data, onSaved, onError }) {
  const [mode, setMode] = useState(''); // '' | 'edit' | 'close'
  const [values, setValues] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const now = site.now;
  const over = now.budget != null && now.ordered > now.budget;

  function startEdit() {
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
      await api('POST', '/customer/budgets', { action: 'save', site: site.id, values: out });
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
        <s-text type="strong">{site.name}</s-text>
        {now.budget == null ? (
          <s-text color="subdued">{data.thisMonth.label}: no budget set · {money(now.ordered)} ordered</s-text>
        ) : (
          <>
            <s-text>{data.thisMonth.label}: {money(now.ordered)} of {money(now.budget)} ordered</s-text>
            <s-progress value={Math.min(now.ordered, now.budget)} max={now.budget || 1} tone={over ? 'critical' : 'auto'} accessibilityLabel="Budget used this month" />
            <s-text color="subdued">{over ? `Over by ${money(now.ordered - now.budget)}` : `${money(now.budget - now.ordered)} left`}{now.awaiting ? ` · ${money(now.awaiting)} waiting for approval` : ''}</s-text>
          </>
        )}
        <s-text color="subdued">
          Every month: {site.default == null ? 'not set' : money(site.default)}
          {data.quarter.months.map((m, i) => ` · ${m.label}: ${site.effective[i] == null ? '–' : money(site.effective[i])}`).join('')}
        </s-text>

        {mode === 'edit' && (
          <s-stack direction="block" gap="base">
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

        {!mode && (
          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" onClick={startEdit}>Edit budgets</s-button>
            <s-button variant="secondary" tone="critical" onClick={() => setMode('close')}>We no longer use this site</s-button>
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
  return (
    <s-section heading={`Year summary: ${y.label}`}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-button variant="secondary" disabled={loading} onClick={() => onFy(y.prev)}>‹ Previous year</s-button>
          <s-button variant="secondary" disabled={loading} onClick={() => onFy(y.next)}>Next year ›</s-button>
        </s-stack>
        <SiteSelect data={data} onSite={onSite} />
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
      </s-stack>
    </s-section>
  );
}

function Orders({ data }) {
  return (
    <s-section heading={`Order history: ${data.year.label}${data.year.site ? ` · ${data.sites.find((s) => s.id === data.year.site)?.name ?? ''}` : ''}`}>
      <s-stack direction="block" gap="base">
        {data.exportUrl && <s-button href={data.exportUrl} target="_blank" variant="secondary">Download CSV</s-button>}
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
      </s-stack>
    </s-section>
  );
}
