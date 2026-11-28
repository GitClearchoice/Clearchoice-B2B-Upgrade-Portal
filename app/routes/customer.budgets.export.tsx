import type { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import { graphqlFor } from "../orders.server";
import { exportBudgetsCsv, exportCsv, exportYearCsv, verifyExport } from "../customer-budgets.server";

// CSV downloads from the customer account "Site budgets" page, opened with a signed link that's valid
// for 15 minutes: kind=orders (order history for a financial year, optionally one site) or
// kind=budgets (the sites' budgets for a quarter, the same file the page imports) or kind=year (the
// year summary report: months, then each site's totals).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const q = new URL(request.url).searchParams;
  if (!verifyExport(process.env.SHOPIFY_API_SECRET ?? "", q)) {
    return new Response("This download link has expired. Go back to Site budgets and tap the download button again.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const shop = q.get("shop")!;
  const company = q.get("company")!;
  const kind = q.get("kind");
  const shopify = () => unauthenticated.admin(shop).then((r) => graphqlFor(r.admin));
  const { filename, csv } =
    kind === "budgets"
      ? await exportBudgetsCsv(shop, await shopify(), company, q.get("quarter"))
      : kind === "year"
        ? await exportYearCsv(shop, await shopify(), company, q.get("fy"), q.get("site"))
        : await exportCsv(shop, company, q.get("fy")!, q.get("site"));
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
};
