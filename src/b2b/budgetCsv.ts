// Budgets CSV (used by the head-office admin's Site budgets page): one row per site with
// "Site", "Every month", one column per month "Oct 2026 (2026-10)", and "Site ID".

export function csvCell(v: unknown): string {
  const t = String(v ?? "");
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** "Oct 2026 (2026-10)" → "2026-10"; "Every month" → "default"; anything else → null. */
export function columnKey(h: string): string | null {
  if (/every\s*month/i.test(h)) return "default";
  const m = /(\d{4}-\d{2})/.exec(h);
  return m ? m[1]! : null;
}

export interface BudgetCsvRow {
  site?: string;
  siteId?: string;
  /** Present when the file has a "Site code" column (blank = clear the code). */
  siteCode?: string;
  values: Record<string, number | null>;
}

/** Reads a budgets CSV. Throws with a plain-English message if it can't be used (nothing is saved then). */
export function readBudgetCsv(text: string): BudgetCsvRow[] {
  const rows = parseCsv(text);
  const header = (rows.shift() ?? []).map((h) => h.trim());
  const siteCol = header.findIndex((h) => /^site$/i.test(h));
  const idCol = header.findIndex((h) => /^site id$/i.test(h));
  const codeCol = header.findIndex((h) => /^site code$/i.test(h));
  const valueCols = header.map((h, i) => ({ i, key: columnKey(h) })).filter((c) => c.key);
  if (siteCol < 0 && idCol < 0) throw new Error('The CSV needs a "Site" or "Site ID" column. Export first and use that file as the template.');
  if (!valueCols.length) throw new Error('The CSV needs an "Every month" column and/or month columns like "Oct 2026 (2026-10)".');
  const bad: string[] = [];
  const out = rows.map((r, n) => {
    const values: Record<string, number | null> = {};
    for (const c of valueCols) {
      const raw = (r[c.i] ?? "").replace(/[$,\s]/g, "");
      if (!raw) values[c.key!] = null;
      else if (Number.isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) < 100_000_000) values[c.key!] = Math.round(Number(raw) * 100) / 100;
      else bad.push(`row ${n + 2}: "${r[c.i]}"`);
    }
    return {
      site: siteCol >= 0 ? r[siteCol]?.trim() : undefined,
      siteId: idCol >= 0 ? r[idCol]?.trim() : undefined,
      ...(codeCol >= 0 ? { siteCode: (r[codeCol] ?? "").trim() } : {}),
      values,
    };
  });
  if (bad.length) throw new Error(`Not a valid amount: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}. Nothing was imported.`);
  return out;
}

export function writeBudgetCsv(
  months: { key: string; label: string }[],
  sites: { id: string; name: string; code?: string | null; default: number | null; months: (number | null)[] }[],
): string {
  const header = ["Site", "Site code", "Every month", ...months.map((m) => `${m.label} (${m.key})`), "Site ID"];
  const lines = sites.map((s) => [s.name, s.code ?? "", s.default ?? "", ...s.months.map((v) => v ?? ""), s.id].map(csvCell).join(","));
  return "﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n");
}
