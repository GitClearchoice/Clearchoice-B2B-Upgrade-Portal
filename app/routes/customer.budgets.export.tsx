import type { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import { graphqlFor } from "../orders.server";
import { exportBudgetsCsv, exportCsv, verifyExport } from "../customer-budgets.server";

// CSV downloads from the customer account "Site budgets" page, opened with a signed link that's valid
// for 15 minutes: kind=orders (order history for a financial year, optionally one site) or
// kind=budgets (the sites' budgets for a quarter, the same file the page imports).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const q = new URL(request.url).searchParams;
  if (!verifyExport(process.env.SHOPIFY_API_SECRET ?? "", q)) {
    return new Response("This download link has expired. Go back to Site budgets and tap the download button again.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const shop = q.get("shop")!;
  const company = q.get("company")!;
  const { filename, csv } =
    q.get("kind") === "budgets"
      ? await exportBudgetsCsv(shop, graphqlFor((await unauthenticated.admin(shop)).admin), company, q.get("quarter"))
      : await exportCsv(shop, company, q.get("fy")!, q.get("site"));
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
};
