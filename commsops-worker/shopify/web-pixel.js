// LOT Relay — Shopify Custom Web Pixel
// Paste this into Shopify admin → Settings → Customer events → Add custom pixel.
// FIRST clear the editor (Cmd+A, Delete) so none of Shopify's default scaffold
// remains, THEN paste this. Replace __PIXEL_TOKEN__ with the commsops `PIXEL_TOKEN`.
// Privacy: Permission = "Not required"; Data sale = "does not qualify as data sale"
// (first-party endpoint, no third-party sharing).
//
// Emits the two storefront signals the backend can't see on its own:
//   product_added_to_cart → add_to_cart        (top-of-funnel, usually anonymous)
//   checkout_started       → checkout_started   (the abandoned-cart journey trigger)
// clientId is always sent as a weak browser-session key so an anonymous add_to_cart
// can later merge into the known profile when the same browser checks out with an email.

var ENDPOINT = "https://commsops.afshaan.workers.dev/pixel";
var PIXEL_TOKEN = "__PIXEL_TOKEN__";

function num(v) { return (v === null || v === undefined) ? null : Number(v); }

function post(name, fields, event) {
  try {
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true, // survive the page unload that follows checkout_started
      body: JSON.stringify(Object.assign({
        token: PIXEL_TOKEN,
        event: name,
        client_id: event.clientId || null,
        occurred_at: event.timestamp || null
      }, fields))
    });
  } catch (e) { /* never block the storefront */ }
}

analytics.subscribe("checkout_started", function (event) {
  var c = (event.data && event.data.checkout) || {};
  var price = c.totalPrice || {};
  post("checkout_started", {
    email: c.email || null,
    phone: c.phone || null,
    checkout_token: c.token || null,
    properties: {
      checkout_token: c.token || null,
      total: num(price.amount),
      currency: price.currencyCode || null,
      line_item_count: (c.lineItems && c.lineItems.length) || null
    }
  }, event);
});

analytics.subscribe("product_added_to_cart", function (event) {
  var line = (event.data && event.data.cartLine) || {};
  var m = line.merchandise || {};
  var prod = m.product || {};
  var cost = (line.cost && line.cost.totalAmount) || {};
  post("add_to_cart", {
    properties: {
      product_title: prod.title || m.title || null,
      variant_id: m.id || null,
      sku: m.sku || null,
      quantity: num(line.quantity),
      price: num(cost.amount)
    }
  }, event);
});
