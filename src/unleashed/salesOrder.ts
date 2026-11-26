// Builds the Unleashed sales order for a trade order (POST /SalesOrders/{guid}).
// Decisions (handover, 26 Nov): status Parked, warehouse Clearchoice Warehouse, tax G.S.T. at 0.1,
// PO number → CustomerRef, site name → DeliveryName.
import type { ShopifyAddress } from "../b2b/address.ts";
import type { ResolvedPrice } from "../pricing/types.ts";
import type { UWarehouse } from "./types.ts";

export interface TradeOrderInput {
  guid: string;
  /** The exact Unleashed customer code (site's unleashed.customer_code, else the company's). */
  customerCode: string;
  poNumber: string;
  site: { name: string; address: ShopifyAddress };
  lines: ResolvedPrice[];
  /** product code → taxable? (GST-free products get no line tax) */
  taxable: (productCode: string) => boolean;
  warehouse: UWarehouse;
  taxCode: string;
  taxRate: number;
  status: string;
  comments?: string;
  orderDate?: Date;
}

const COUNTRY_NAMES: Record<string, string> = { AU: "Australia", NZ: "New Zealand" };
const cents = (n: number) => Math.round(n * 100);
const money = (c: number) => c / 100;

export function buildSalesOrder(o: TradeOrderInput) {
  if (!o.lines.length) throw new Error("A sales order needs at least one line");
  if (!o.poNumber.trim()) throw new Error("A PO number is required");

  let subC = 0;
  let taxC = 0;
  const SalesOrderLines = o.lines.map((l, i) => {
    const lineC = cents(l.lineExGst);
    const lineTaxC = o.taxable(l.productCode) ? Math.round(lineC * o.taxRate) : 0;
    subC += lineC;
    taxC += lineTaxC;
    return {
      LineNumber: i + 1,
      Product: { ProductCode: l.productCode },
      OrderQuantity: l.quantity,
      UnitPrice: l.unitExGst,
      DiscountRate: 0,
      LineTotal: money(lineC),
      LineTax: money(lineTaxC),
      LineTaxCode: o.taxable(l.productCode) ? o.taxCode : undefined,
    };
  });

  const a = o.site.address;
  return {
    Guid: o.guid,
    OrderDate: (o.orderDate ?? new Date()).toISOString(),
    OrderStatus: o.status,
    Customer: { CustomerCode: o.customerCode },
    CustomerRef: o.poNumber.trim().slice(0, 500),
    Comments: o.comments,
    Warehouse: { Guid: o.warehouse.Guid, WarehouseCode: o.warehouse.WarehouseCode, WarehouseName: o.warehouse.WarehouseName },
    Currency: { CurrencyCode: "AUD" },
    ExchangeRate: 1,
    DiscountRate: 0,
    Tax: { TaxCode: o.taxCode },
    TaxRate: o.taxRate,
    DeliveryName: o.site.name,
    DeliveryStreetAddress: a.address1,
    DeliveryStreetAddress2: a.address2 ?? "",
    DeliverySuburb: a.city,
    DeliveryCity: a.city,
    DeliveryRegion: a.zoneCode ?? "",
    DeliveryCountry: COUNTRY_NAMES[a.countryCode] ?? a.countryCode,
    DeliveryPostCode: a.zip ?? "",
    SalesOrderLines,
    SubTotal: money(subC),
    TaxTotal: money(taxC),
    Total: money(subC + taxC),
  };
}
