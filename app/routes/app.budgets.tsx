import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { addMonths, monthLabel, parseQuarter, quarterOf, shortMonthLabel, sydneyMonth, sydneyMonthRange } from "../../src/orders/budget.ts";
import { COMMITTED } from "../budget.server";
import { graphqlFor } from "../orders.server";
import { setSiteClosed, syncSites } from "../sites.server";
import { isDormant } from "../../src/b2b/siteStatus.ts";

// Staff page: monthly site budgets per company (goods ex GST, Sydney calendar month).
// "Every month" is the default; a month's own amount overrides it. Shown one Australian financial-year
// quarter at a time (Q1 Jul–Sep … Q4 Apr–Jun), with previous/next quarter.
// Blank = no budget (no limit). Below: a quarterly summary (budget vs ordered per site).
// Head-office admins get their own page in phase 5.

// All companies (a few hundred at most), filtered here: Shopify's search on names is case-sensitive
// with wildcards and only matches whole words without them.
const COMPANIES = `#graphql
  query BudgetCompanies($after: String) {
    companies(first: 250, after: $after, sortKey: NAME) {
      nodes { id name externalId locationsCount { count } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

type CompanyRow = { id: string; name: string; externalId: string | null; locationsCount: { count: number } };

async function searchCompanies(admin: Gql, q: string): Promise<CompanyRow[]> {
  // Words in any order, ignoring case; also ignoring spaces and punctuation ("facility master" finds "FacilityMaster", "FACILITY-MASTER").
  const compact = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const whole = compact(q);
  const out: CompanyRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: { companies: { nodes: CompanyRow[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(admin, COMPANIES, { after });
    for (const c of d.companies.nodes) {
      const text = `${c.name} ${c.externalId ?? ""}`.toLowerCase().replace(/\s+/g, " ");
      if (words.every((w) => text.includes(w)) || (whole && compact(text).includes(whole))) out.push(c);
    }
    if (!d.companies.pageInfo.hasNextPage) break;
    after = d.companies.pageInfo.endCursor;
  }
  return out.slice(0, 50);
}

const LOCATIONS = `#graphql
  query BudgetLocations($id: ID!, $after: String) {
    company(id: $id) {
      id
      name
      locations(first: 250, after: $after, sortKey: NAME) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

type Gql = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };
async function gql<T>(admin: Gql, q: string, variables: Record<string, unknown>): Promise<T> {
  const r = await admin.graphql(q, { variables });
  const body = (await r.json()) as { data: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}


async function companySites(admin: Gql, companyId: string) {
  const sites: { id: string; name: string }[] = [];
  let name = "";
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: { company: { name: string; locations: { nodes: { id: string; name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } =
      await gql(admin, LOCATIONS, { id: companyId, after });
    if (!d.company) break;
    name = d.company.name;
    sites.push(...d.company.locations.nodes);
    if (!d.company.locations.pageInfo.hasNextPage) break;
    after = d.company.locations.pageInfo.endCursor;
  }
  return { name, sites };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const companyId = url.searchParams.get("company");
  // Budgets are shown a financial-year quarter at a time (default: the current one).
  const quarter = parseQuarter(url.searchParams.get("quarter")) ?? quarterOf(sydneyMonth(new Date()));
  const ms = [...quarter.months];
  const labels = ms.map(shortMonthLabel);

  const companies = q ? await searchCompanies(admin, q) : [];

  if (!companyId) return { q, companies, company: null, months: ms, labels, quarter: null, summary: null };

  const { name, sites: allSites } = await companySites(admin, companyId);
  // Closed sites (obsolete in Unleashed, or closed by the customer) are hidden; dormant = no order in 6 months.
  const statuses = await prisma.siteStatus.findMany({ where: { shop: session.shop, companyId } });
  const statusOf = new Map(statuses.map((st) => [st.locationId, st]));
  const sites = allSites.filter((st) => !statusOf.get(st.id)?.closed);
  const now = new Date();
  const closedSites = allSites
    .filter((st) => statusOf.get(st.id)?.closed)
    .map((st) => {
      const x = statusOf.get(st.id)!;
      return { id: st.id, name: st.name, source: x.source, reason: x.reason, closedBy: x.closedBy, closedAt: x.closedAt?.toISOString() ?? null };
    });
  const siteInfo = (id: string) => {
    const x = statusOf.get(id);
    const checked = !!x; // the daily check has seen this site
    return { lastOrderAt: x?.lastOrderAt?.toISOString() ?? null, dormant: checked && isDormant(x?.lastOrderAt ?? null, now) };
  };
  const rows = await prisma.siteBudget.findMany({
    where: { shop: session.shop, companyId, month: { in: ["default", ...ms] } },
  });
  const val = (loc: string, month: string) => {
    const r = rows.find((x) => x.locationId === loc && x.month === month);
    return r ? Number(r.amountExGst.toString()) : null;
  };
  const effective = (loc: string, month: string) => val(loc, month) ?? val(loc, "default");

  // Quarterly summary: budget (sum of the 3 months; "no limit" if any month has none) vs ordered.
  const range = { start: sydneyMonthRange(quarter.months[0]).start, end: sydneyMonthRange(quarter.months[2]).end };
  const spend = await prisma.tradeOrder.groupBy({
    by: ["locationId", "status"],
    where: { shop: session.shop, companyId, createdAt: { gte: range.start, lt: range.end }, status: { in: [...COMMITTED, "awaiting-approval"] } },
    _sum: { goodsExGst: true },
  });
  const spentOf = (loc: string, awaiting: boolean) =>
    spend
      .filter((g) => g.locationId === loc && (g.status === "awaiting-approval") === awaiting)
      .reduce((t, g) => t + Number(g._sum.goodsExGst?.toString() ?? 0), 0);
  const summaryRows = sites.map((s) => {
    const monthly = quarter.months.map((m) => effective(s.id, m));
    const budget = monthly.some((v) => v == null) ? null : monthly.reduce<number>((t, v) => t + (v ?? 0), 0);
    const ordered = Math.round(spentOf(s.id, false) * 100) / 100;
    const awaiting = Math.round(spentOf(s.id, true) * 100) / 100;
    return { id: s.id, name: s.name, budget, ordered, awaiting, remaining: budget == null ? null : Math.round((budget - ordered) * 100) / 100 };
  });
  const sum = (xs: number[]) => Math.round(xs.reduce((t, v) => t + v, 0) * 100) / 100;
  const summary = {
    rows: summaryRows,
    totals: {
      budget: sum(summaryRows.filter((r) => r.budget != null).map((r) => r.budget!)),
      ordered: sum(summaryRows.map((r) => r.ordered)),
      awaiting: sum(summaryRows.map((r) => r.awaiting)),
      unbudgeted: summaryRows.filter((r) => r.budget == null).length,
    },
    prev: quarterOf(addMonths(quarter.months[0], -3)).key,
    next: quarterOf(addMonths(quarter.months[0], 3)).key,
  };
  const orders = await prisma.tradeOrder.findMany({
    where: { shop: session.shop, companyId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, draftOrderName: true, siteName: true, poNumber: true, goodsExGst: true, status: true, unleashedOrderNumber: true, createdAt: true, approverEmail: true },
  });
  return {
    q,
    companies,
    months: ms,
    labels,
    quarter,
    summary,
    company: {
      id: companyId,
      name,
      sites: sites.map((s) => ({ ...s, ...siteInfo(s.id), default: val(s.id, "default"), months: ms.map((m) => val(s.id, m)) })),
      closedSites,
      showClosed: url.searchParams.get("closed") === "1",
    },
    orders: orders.map((o) => ({ ...o, goodsExGst: Number(o.goodsExGst.toString()), createdAt: o.createdAt.toISOString() })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const companyId = String(form.get("company") ?? "");
  if (!companyId) return { error: "No company selected" };
  const intent = String(form.get("intent") ?? "save");
  if (intent === "sync") {
    try {
      const r = await syncSites(graphqlFor(admin), session.shop);
      return {
        synced: `Checked ${r.sites} sites against Unleashed: ${r.changes.length} added or updated, ${r.closed.length} closed, ${r.reopened.length} reopened.${r.errors.length ? ` ${r.errors.length} errors.` : ""}`,
        details: [...r.changes, ...r.closed.map((c) => `Closed: ${c}`), ...r.reopened.map((c) => `Reopened: ${c}`), ...r.errors.map((e) => `Error: ${e}`)],
      };
    } catch (e) {
      return { error: `Unleashed check failed: ${(e as Error).message}` };
    }
  }
  if (intent === "reopen") {
    const locationId = String(form.get("location") ?? "");
    const siteName = String(form.get("siteName") ?? "");
    await setSiteClosed(graphqlFor(admin), session.shop, { locationId, companyId, name: siteName }, false, {
      source: "staff",
      reason: "reopened by Clearchoice staff",
      by: session.onlineAccessInfo?.associated_user?.email ?? "staff",
    });
    return { synced: `${siteName} reopened.` };
  }
  // The months on the form: the quarter being edited.
  const quarter = parseQuarter(String(form.get("quarter") ?? "")) ?? quarterOf(sydneyMonth(new Date()));
  const ms = [...quarter.months];
  const { sites } = await companySites(admin, companyId);
  const allDefault = String(form.get("allDefault") ?? "").trim();

  const parse = (raw: string): number | null | "bad" => {
    const t = raw.replace(/[$,\s]/g, "");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 && n < 100_000_000 ? Math.round(n * 100) / 100 : "bad";
  };
  const bad: string[] = [];
  const ops = [];
  for (const site of sites) {
    const fields: [string, string][] = [["default", "default"], ...ms.map((m, i): [string, string] => [`m${i}`, m])];
    for (const [field, month] of fields) {
      let raw = form.get(`${field}:${site.id}`);
      if (field === "default" && allDefault) raw = allDefault;
      if (raw === null) continue; // not on the form
      const v = parse(String(raw));
      if (v === "bad") { bad.push(`${site.name} (${field === "default" ? "every month" : monthLabel(month)})`); continue; }
      const where = { shop_locationId_month: { shop: session.shop, locationId: site.id, month } };
      ops.push(
        v == null
          ? prisma.siteBudget.deleteMany({ where: { shop: session.shop, locationId: site.id, month } })
          : prisma.siteBudget.upsert({
              where,
              create: { shop: session.shop, companyId, locationId: site.id, siteName: site.name, month, amountExGst: v, updatedBy: session.onlineAccessInfo?.associated_user?.email ?? null },
              update: { amountExGst: v, siteName: site.name, updatedBy: session.onlineAccessInfo?.associated_user?.email ?? null },
            }),
      );
    }
  }
  if (bad.length) return { error: `Not a valid amount: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}` };
  await prisma.$transaction(ops);
  return { saved: true };
};

// Tables scroll inside their own box with the headings pinned to the top, so long site lists keep
// their column headings in view.
const scrollBox: React.CSSProperties = { maxHeight: "70vh", overflow: "auto", border: "1px solid #e3e3e3", borderRadius: 8 };
const table: React.CSSProperties = { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 };
const th: React.CSSProperties = { position: "sticky", top: 0, zIndex: 1, background: "#f7f7f7", textAlign: "left", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #d4d4d4", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid #eee", verticalAlign: "middle" };
const tdTotal: React.CSSProperties = { ...td, fontWeight: 600, position: "sticky", bottom: 0, background: "#fff", borderTop: "1px solid #d4d4d4" };

const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusLabel: Record<string, string> = {
  sent: "Sent to Unleashed",
  pending: "Sending",
  failed: "Retrying",
  "awaiting-approval": "Awaiting approval",
  rejected: "Declined",
};

export default function Budgets() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  // Site search: hides non-matching rows (they stay in the form, so saving keeps their amounts).
  const [siteFilter, setSiteFilter] = useState("");
  const words = siteFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (name: string) => words.every((w) => name.toLowerCase().includes(w));
  const hide = (name: string): React.CSSProperties | undefined => (shown(name) ? undefined : { display: "none" });
  const matchCount = data.company ? data.company.sites.filter((x) => shown(x.name)).length : 0;

  return (
    <s-page heading="Site budgets">
      <s-section heading="Find a company">
        {/* Enter in the field searches (the Polaris field doesn't submit the form by itself). */}
        <Form
          method="get"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
        >
          <s-stack direction="inline" gap="base">
            <s-text-field label="Company name or Unleashed code (any part, any case)" name="q" value={data.q} />
            <s-button type="submit">Search</s-button>
          </s-stack>
        </Form>
        {data.companies.length > 0 && (
          <s-stack direction="block" gap="small-200">
            {data.companies.map((c) => (
              <s-link key={c.id} href={`/app/budgets?q=${encodeURIComponent(data.q)}&company=${encodeURIComponent(c.id)}`}>
                {c.name} ({c.locationsCount.count} sites)
              </s-link>
            ))}
          </s-stack>
        )}
        {data.q && data.companies.length === 0 && <s-paragraph>No companies match "{data.q}".</s-paragraph>}
      </s-section>

      {data.company && (
        <s-section heading={`${data.company.name}: monthly budgets (goods ex GST)`}>
          <s-paragraph>
            "Every month" applies unless a month has its own amount. Leave blank for no budget (orders are never held for
            approval). Orders that would take a site over its budget are emailed to the company's head-office admin.
          </s-paragraph>
          {result && "error" in result && <s-banner tone="critical">{result.error}</s-banner>}
          {result && "saved" in result && <s-banner tone="success">Budgets saved.</s-banner>}
          {result && "synced" in result && (
            <s-banner tone="success">
              {result.synced}
              {"details" in result && result.details && result.details.length > 0 && (
                <s-unordered-list>
                  {result.details.slice(0, 100).map((d, i) => <s-list-item key={i}>{d}</s-list-item>)}
                </s-unordered-list>
              )}
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-text>
              Sites follow Unleashed daily: names, addresses and delivery notes are updated, new Delivery tab sites are added and obsolete ones closed. "Dormant" = no order for 6 months.
              {data.company.closedSites.length > 0 && ` ${data.company.closedSites.length} closed site(s) hidden.`}
            </s-text>
            {data.company.closedSites.length > 0 && (
              <s-link href={`/app/budgets?q=${encodeURIComponent(data.q)}&company=${encodeURIComponent(data.company.id)}${data.company.showClosed ? "" : "&closed=1"}`}>
                {data.company.showClosed ? "Hide closed sites" : "Show closed sites"}
              </s-link>
            )}
            <Form method="post">
              <input type="hidden" name="company" value={data.company.id} />
              <input type="hidden" name="intent" value="sync" />
              <s-button type="submit" variant="tertiary" {...(busy ? { loading: true } : {})}>Update sites from Unleashed now</s-button>
            </Form>
          </s-stack>
          {data.quarter && data.summary && (
            <s-stack direction="inline" gap="base">
              <s-text type="strong">{data.quarter.label}</s-text>
              <s-link href={`/app/budgets?q=${encodeURIComponent(data.q)}&company=${encodeURIComponent(data.company.id)}&quarter=${data.summary.prev}`}>‹ Previous quarter</s-link>
              <s-link href={`/app/budgets?q=${encodeURIComponent(data.q)}&company=${encodeURIComponent(data.company.id)}&quarter=${data.summary.next}`}>Next quarter ›</s-link>
            </s-stack>
          )}
          <Form method="post" key={params.toString() + (result && "saved" in result ? Date.now() : "")}>
            <input type="hidden" name="company" value={data.company.id} />
            <input type="hidden" name="quarter" value={data.quarter?.key ?? ""} />
            <s-stack direction="block" gap="base">
              <s-text-field label="Set 'every month' for all sites (optional)" name="allDefault" placeholder="e.g. 2000" />
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <input
                  type="search"
                  value={siteFilter}
                  onChange={(e) => setSiteFilter(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                  placeholder="Search sites (any part of the name)"
                  aria-label="Search sites"
                  style={{ flex: "1 1 260px", maxWidth: 420, padding: "8px 12px", fontSize: 14, border: "1px solid #8a8a8a", borderRadius: 8 }}
                />
                {siteFilter && <s-text color="subdued">{matchCount} of {data.company.sites.length} sites</s-text>}
              </div>
              <div style={scrollBox}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Site</th>
                    <th style={th}>Every month</th>
                    {data.labels.map((l) => <th style={th} key={l}>{l}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.company.sites.map((s) => (
                    <tr key={s.id} style={hide(s.name)}>
                      <td style={td}>
                        {s.name}
                        {s.dormant && (
                          <>
                            {" "}
                            <s-badge tone="warning">Dormant</s-badge>
                            <s-text color="subdued">{s.lastOrderAt ? ` Last order ${new Date(s.lastOrderAt).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" })}` : " No orders found"}</s-text>
                          </>
                        )}
                      </td>
                      <td style={td}><s-text-field label="Every month" labelAccessibilityVisibility="exclusive" name={`default:${s.id}`} value={s.default?.toString() ?? ""} /></td>
                      {s.months.map((v, i) => (
                        <td style={td} key={i}><s-text-field label={data.labels[i]!} labelAccessibilityVisibility="exclusive" name={`m${i}:${s.id}`} value={v?.toString() ?? ""} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>Save budgets</s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {data.company && data.company.showClosed && data.company.closedSites.length > 0 && (
        <s-section heading="Closed sites (hidden)">
          <s-table>
            <s-table-header-row>
              <s-table-header>Site</s-table-header>
              <s-table-header>Why</s-table-header>
              <s-table-header>Closed</s-table-header>
              <s-table-header />
            </s-table-header-row>
            <s-table-body>
              {data.company.closedSites.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>{c.name}</s-table-cell>
                  <s-table-cell>{c.source === "customer" ? `Closed by the customer${c.reason ? `: ${c.reason}` : ""}` : c.reason ?? c.source}</s-table-cell>
                  <s-table-cell>{c.closedAt ? new Date(c.closedAt).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) : ""}{c.closedBy ? ` (${c.closedBy})` : ""}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="company" value={data.company!.id} />
                      <input type="hidden" name="intent" value="reopen" />
                      <input type="hidden" name="location" value={c.id} />
                      <input type="hidden" name="siteName" value={c.name} />
                      <s-button type="submit" variant="tertiary">Reopen</s-button>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-paragraph>A site closed because it's obsolete in Unleashed reopens by itself when it's made active there again.</s-paragraph>
        </s-section>
      )}

      {data.company && data.summary && data.quarter && (
        <s-section heading={`Quarterly summary: ${data.quarter.label}`}>
          <s-paragraph>
            Goods ex GST. Budget = the three months added up ("No budget" if any month has none). Ordered = sent to
            Clearchoice (incl. approved orders); declined orders don't count.
          </s-paragraph>
          <div style={scrollBox}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Site</th>
                  <th style={{ ...th, textAlign: "right" }}>Quarter budget</th>
                  <th style={{ ...th, textAlign: "right" }}>Ordered</th>
                  <th style={{ ...th, textAlign: "right" }}>Waiting for approval</th>
                  <th style={{ ...th, textAlign: "right" }}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.rows.map((r) => (
                  <tr key={r.id} style={hide(r.name)}>
                    <td style={td}>{r.name}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.budget == null ? "No budget" : money(r.budget)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{money(r.ordered)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.awaiting ? money(r.awaiting) : "–"}</td>
                    <td style={{ ...td, textAlign: "right", ...(r.remaining != null && r.remaining < 0 ? { color: "#c00", fontWeight: 600 } : {}) }}>
                      {r.remaining == null ? "–" : r.remaining < 0 ? `Over by ${money(-r.remaining)}` : money(r.remaining)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={tdTotal}>All sites</td>
                  <td style={{ ...tdTotal, textAlign: "right" }}>{money(data.summary.totals.budget)}{data.summary.totals.unbudgeted ? ` (+${data.summary.totals.unbudgeted} without budget)` : ""}</td>
                  <td style={{ ...tdTotal, textAlign: "right" }}>{money(data.summary.totals.ordered)}</td>
                  <td style={{ ...tdTotal, textAlign: "right" }}>{data.summary.totals.awaiting ? money(data.summary.totals.awaiting) : "–"}</td>
                  <td style={tdTotal} />
                </tr>
              </tfoot>
            </table>
          </div>
        </s-section>
      )}

      {data.company && "orders" in data && data.orders && data.orders.length > 0 && (
        <s-section heading="Recent trade orders">
          <s-table>
            <s-table-header-row>
              <s-table-header>Placed</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Site</s-table-header>
              <s-table-header>PO</s-table-header>
              <s-table-header>Goods ex GST</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.orders.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>{new Date(o.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "short", timeStyle: "short" })}</s-table-cell>
                  <s-table-cell>{o.draftOrderName}{o.unleashedOrderNumber ? ` / ${o.unleashedOrderNumber}` : ""}</s-table-cell>
                  <s-table-cell>{o.siteName}</s-table-cell>
                  <s-table-cell>{o.poNumber}</s-table-cell>
                  <s-table-cell>{money(o.goodsExGst)}</s-table-cell>
                  <s-table-cell>{statusLabel[o.status] ?? o.status}{o.status === "awaiting-approval" && o.approverEmail ? ` (${o.approverEmail})` : ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
