import type { LoaderFunctionArgs } from "react-router";
import { exportCsv, verifyExport } from "../customer-budgets.server";

// CSV of a company's trade orders for a financial year (optionally one site). Opened from the
// customer account "Site budgets" page with a signed link that's valid for 15 minutes.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const q = new URL(request.url).searchParams;
  if (!verifyExport(process.env.SHOPIFY_API_SECRET ?? "", q)) {
    return new Response("This download link has expired. Go back to Site budgets and tap Download CSV again.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const { filename, csv } = await exportCsv(q.get("shop")!, q.get("company")!, q.get("fy")!, q.get("site"));
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
};
