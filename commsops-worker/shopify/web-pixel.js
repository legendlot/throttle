// LOT Relay — Shopify Custom Web Pixel
// Paste this into Shopify admin → Settings → Customer events → Add custom pixel.
// Replace __PIXEL_TOKEN__ with the value set as the commsops `PIXEL_TOKEN` secret.
//
// Emits the two storefront signals the backend can't see on its own:
//   product_added_to_cart → add_to_cart        (top-of-funnel, usually anonymous)
//   checkout_started       → checkout_started   (the abandoned-cart journey trigger)
// Posts to the low-trust public commsops /pixel endpoint. clientId is always sent
// as a weak browser-session key so an anonymous add_to_cart can later merge into the
// known profile when the same browser checks out with an email.

const ENDPOINT = "https://commsops.afshaan.workers.dev/pixel";
const PIXEL_TOKEN = "__PIXEL_TOKEN__";

function post(name, fields, event) {
  try {
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true, // survive the page unload that follows checkout_started
      body: JSON.stringify({
        token: PIXEL_TOKEN,
        event: name,
        client_id: event.clientId || null,
        occurred_at: event.timestamp || null,
        ...fields,
      }),
    });
  } catch (e) { /* never block the storefront */ }
}

analytics.subscribe("checkout_started", (event) => {
  const c = (event.data && event.data.checkout) || {};
  post("checkout_started", {
    email: c.email || null,
    phone: c.phone || null,
    checkout_token: c.token || null,
    properties: {
      checkout_token: c.token || null,
      total: c.totalPrice && c.totalPrice.amount != null ? Number(c.totalPrice.amount) : null,
      currency: c.totalPrice && c.totalPrice.currencyCode ? c.totalPrice.currencyCode : null,
      line_item_count: Array.isArray(c.lineItems) ? c.lineItems.length : null,
    },
  }, event);
});

analytics.subscribe("product_added_to_cart", (event) => {
  const line = (event.data && event.data.cartLine) || {};
  const m = line.merchandise || {};
  post("add_to_cart", {
    properties: {
      product_title: (m.product && m.product.title) || m.title || null,
      variant_id: m.id || null,
      sku: m.sku || null,
      quantity: line.quantity != null ? Number(line.quantity) : null,
      price: line.cost && line.cost.totalAmount && line.cost.totalAmount.amount != null
        ? Number(line.cost.totalAmount.amount) : null,
    },
  }, event);
});
