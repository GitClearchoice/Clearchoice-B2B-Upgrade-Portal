// Site budgets (HANDOVER "Decisions"): a monthly total per delivery site, goods only (ex GST, ex
// freight), Sydney calendar month. Orders that would take a site over its budget go to the
// head-office admin for approval. A site with no budget has no limit.

/** "YYYY-MM" of the given instant in Australia/Sydney. */
export function sydneyMonth(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit" }).format(at);
}

/** UTC instant of local midnight on the given Sydney date. */
function sydneyMidnight(y: number, m: number, d: number): Date {
  // Start from midnight UTC and correct by Sydney's offset at that moment (twice, for DST edges).
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
    const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    t -= shown - Date.UTC(y, m - 1, d);
  }
  return new Date(t);
}

/** [start, end) of a Sydney calendar month, as UTC instants. */
export function sydneyMonthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { start: sydneyMidnight(y, m, 1), end: sydneyMidnight(next[0]!, next[1]!, 1) };
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
}

export interface BudgetRepo {
  /** The site's budget for the month: that month's amount if set, else the site's default; null = no limit. */
  budgetFor(shop: string, locationId: string, month: string): Promise<number | null>;
  /**
   * Goods ex GST of the site's orders placed in the month: `committed` = sent or on their way to
   * Unleashed (incl. approved), `awaitingApproval` = waiting for the head-office admin.
   */
  spendFor(shop: string, locationId: string, month: string): Promise<{ committed: number; awaitingApproval: number }>;
}

export interface BudgetStatus {
  month: string;
  budget: number | null;
  committed: number;
  awaitingApproval: number;
  /** budget − committed (null when there's no budget). */
  remaining: number | null;
}

export async function budgetStatus(repo: BudgetRepo, shop: string, locationId: string, at: Date): Promise<BudgetStatus> {
  const month = sydneyMonth(at);
  const [budget, spend] = await Promise.all([repo.budgetFor(shop, locationId, month), repo.spendFor(shop, locationId, month)]);
  return {
    month,
    budget,
    committed: cents(spend.committed),
    awaitingApproval: cents(spend.awaitingApproval),
    remaining: budget == null ? null : cents(budget - spend.committed),
  };
}

/** Would this order take the site over its budget? Orders awaiting approval don't count until approved. */
export function needsApproval(status: BudgetStatus, orderExGst: number): boolean {
  if (status.budget == null) return false;
  return Math.round((status.committed + orderExGst) * 100) > Math.round(status.budget * 100);
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** "YYYY-MM" n months after (or before, if negative) the given month. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Short label for table headings: "Dec 2026". */
export function shortMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Calendar quarter ("2026-Q4" = Oct–Dec 2026; Australian FY quarters use the same months). */
export interface Quarter {
  key: string;
  label: string;
  months: [string, string, string];
}

export function quarterOf(month: string): Quarter {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3) + 1;
  const first = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
  const months: [string, string, string] = [first, addMonths(first, 1), addMonths(first, 2)];
  const short = (mm: string) => shortMonthLabel(mm).split(" ")[0];
  return { key: `${y}-Q${q}`, label: `Q${q}: ${short(months[0])}–${short(months[2])} ${y}`, months };
}

/** Parses "2026-Q4"; null if it isn't one. */
export function parseQuarter(key: string | null | undefined): Quarter | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key ?? "");
  return m ? quarterOf(`${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}`) : null;
}
