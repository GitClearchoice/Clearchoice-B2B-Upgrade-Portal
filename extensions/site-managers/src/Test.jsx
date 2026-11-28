import '@shopify/ui-extensions/preact';
import { render } from 'preact';

// TEMPORARY diagnostic: the smallest possible page. If this shows, Shopify can load the extension
// and the problem is in SiteManagers.jsx; if not, it's the extension's setup on Shopify's side.
export default async () => {
  render(
    <s-page heading="Site managers">
      <s-text>Test page: the extension loaded.</s-text>
    </s-page>,
    document.body,
  );
};
