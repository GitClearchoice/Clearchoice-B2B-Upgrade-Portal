import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// The app's backend (Render web service). Keep in step with application_url in shopify.app.toml.
const APP_URL = 'https://clearchoice-b2b.onrender.com';

export default async () => {
  render(<PoSetting />, document.body);
};

async function call(method, body) {
  const token = await shopify.sessionToken.get();
  const res = await fetch(`${APP_URL}/customer/po-setting`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function PoSetting() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    call('GET').then(setState).catch((e) => setError(e.message));
  }, []);

  if (!state && !error) return null;
  if (state && !state.trade) return null;

  async function onChange(event) {
    const notRequired = event.currentTarget.checked;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const r = await call('POST', { notRequired });
      setState({ ...state, notRequired: r.notRequired });
      setSaved(r.notRequired ? 'Saved. PO numbers are now optional on all your orders.' : 'Saved. A PO number is needed on your orders again.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-section heading="Purchase orders">
      <s-stack direction="block" gap="base">
        {state && state.isAdmin && (
          <s-checkbox
            label="We don't use purchase orders"
            checked={state.notRequired}
            disabled={busy}
            onChange={onChange}
          />
        )}
        {state && (
          <s-text color="subdued">
            {state.notRequired
              ? `${state.companyName} doesn't use purchase orders: the PO number is optional on all orders until this is unticked.`
              : `${state.companyName} needs a PO number on every order.`}
            {state.isAdmin ? '' : ' Only your head-office admin can change this.'}
          </s-text>
        )}
        {saved && <s-banner tone="success">{saved}</s-banner>}
        {error && <s-banner tone="critical">{error}</s-banner>}
      </s-stack>
    </s-section>
  );
}
