// Raw shapes returned by the Unleashed API (JSON), limited to the fields we use.
// Field names follow apidocs.unleashedsoftware.com (Products, Customers, ProductPrices, SellPriceTiers).

export interface UPagination {
  NumberOfItems: number;
  PageSize: number;
  PageNumber: number;
  NumberOfPages: number;
}

export interface UPage<T> {
  Pagination?: UPagination;
  Items: T[];
}

export interface UTierValue {
  Name?: string | null;
  Value?: number | string | null;
}

export interface UProduct {
  Guid: string;
  ProductCode: string;
  ProductDescription?: string | null;
  DefaultSellPrice?: number | null;
  SellPriceTier1?: UTierValue | null;
  SellPriceTier2?: UTierValue | null;
  SellPriceTier3?: UTierValue | null;
  SellPriceTier4?: UTierValue | null;
  SellPriceTier5?: UTierValue | null;
  SellPriceTier6?: UTierValue | null;
  SellPriceTier7?: UTierValue | null;
  SellPriceTier8?: UTierValue | null;
  SellPriceTier9?: UTierValue | null;
  SellPriceTier10?: UTierValue | null;
  ProductGroup?: { Guid?: string; GroupName?: string | null; ParentGroupGuid?: string | null } | null;
  Obsolete?: boolean;
  IsSellable?: boolean;
  TaxableSales?: boolean | null;
  LastModifiedOn?: string | null;
}

export interface UAddress {
  Guid?: string;
  AddressName?: string | null;
  AddressType?: string | null; // Postal | Physical | Shipping
  StreetAddress?: string | null;
  StreetAddress2?: string | null;
  Suburb?: string | null;
  City?: string | null;
  Region?: string | null;
  Country?: string | null;
  PostalCode?: string | null;
  DeliveryInstruction?: string | null;
  IsDefault?: boolean | null;
  Obsolete?: boolean | null;
}

export interface UCustomer {
  Guid: string;
  CustomerCode: string;
  CustomerName?: string | null;
  ContactFirstName?: string | null;
  ContactLastName?: string | null;
  Email?: string | null;
  PhoneNumber?: string | null;
  PaymentTerm?: string | null;
  CustomerType?: string | null;
  Addresses?: UAddress[] | null;
  SellPriceTier?: string | null;
  SellPriceTierReference?: { Tier?: number | null; Name?: string | null } | null;
  DiscountRate?: number | null;
  Taxable?: boolean | null;
  TaxCode?: string | null;
  Obsolete?: boolean;
  LastModifiedOn?: string | null;
}

export interface UProductPrice {
  Guid: string;
  Product?: { Guid?: string; ProductCode?: string | null; ProductDescription?: string | null } | null;
  ProductGroup?: { Guid?: string; GroupName?: string | null } | null;
  Customer?: { Guid?: string; CustomerCode?: string | null; CustomerName?: string | null } | null;
  PriceType?: string | null; // "Fixed Price" | "Discount %"
  DiscountValue?: number | null;
  MinimumQuantity?: number | null;
  DefaultSellPrice?: number | null;
  CustomerPrice?: number | null;
  ValidFrom?: string | null;
  ValidTo?: string | null;
  Comments?: string | null;
  LastModifiedOn?: string | null;
}

export interface USellPriceTier {
  Tier: number;
  Name: string;
}

/** One customer's Delivery tab (GET /CustomerDeliveryAddresses). */
export interface UCustomerDeliveryAddresses {
  CustomerCode: string;
  Addresses?: UAddress[] | null;
}

/** Only the fields we read from GET /SalesOrders. */
export interface USalesOrder {
  OrderNumber?: string | null;
  OrderDate?: string | null;
  OrderStatus?: string | null;
  Customer?: { CustomerCode?: string | null } | null;
  DeliveryName?: string | null;
}

export interface UWarehouse {
  Guid: string;
  WarehouseCode: string;
  WarehouseName: string;
  Obsolete?: boolean;
}

export interface UTax {
  Guid?: string;
  TaxCode: string;
  TaxRate: number;
  Description?: string | null;
  SalesTax?: boolean;
  Obsolete?: boolean;
}
