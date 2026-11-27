import prisma from "./db.server";
import { sydneyMonthRange, type BudgetRepo } from "../src/orders/budget.ts";

// Statuses that count against a site's budget: sent, on the way (incl. approved), or retrying.
export const COMMITTED = ["pending", "sent", "failed"];

export const budgetRepo: BudgetRepo = {
  async budgetFor(shop, locationId, month) {
    const rows = await prisma.siteBudget.findMany({ where: { shop, locationId, month: { in: [month, "default"] } } });
    const row = rows.find((r) => r.month === month) ?? rows.find((r) => r.month === "default");
    return row ? Number(row.amountExGst.toString()) : null;
  },
  async spendFor(shop, locationId, month) {
    const { start, end } = sydneyMonthRange(month);
    const groups = await prisma.tradeOrder.groupBy({
      by: ["status"],
      where: { shop, locationId, createdAt: { gte: start, lt: end }, status: { in: [...COMMITTED, "awaiting-approval"] } },
      _sum: { goodsExGst: true },
    });
    let committed = 0;
    let awaitingApproval = 0;
    for (const g of groups) {
      const v = Number(g._sum.goodsExGst?.toString() ?? 0);
      if (g.status === "awaiting-approval") awaitingApproval += v;
      else committed += v;
    }
    return { committed, awaitingApproval };
  },
};
