import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/PoSetting.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.profile.company-location-payment.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
