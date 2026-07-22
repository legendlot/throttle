// LOT Relay — Shopify Custom Web Pixel
// Paste this into Shopify admin → Settings → Customer events → Add custom pixel.
// FIRST clear the editor (Cmd+A, Delete) so none of Shopify's default scaffold
// remains, THEN paste this. Replace __PIXEL_TOKEN__ with the commsops `PIXEL_TOKEN`.
// Privacy: Permission = "Not required"; Data sale = "does not qualify as data sale"
// (first-party endpoint, no third-party sharing).
//
// Emits the three storefront signals the backend can't see on its own:
//   product_viewed         → product_viewed     (the browse-abandonment trigger; the
//                                                backend keeps it ATTACH-ONLY — views
//                                                from unknown browsers are dropped)
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

// Best-effort cart key. `init` is a page-render snapshot, so cart may be absent on the very
// first add — hence the defensive reads. NOTE this is the Web Pixel cart id, which Shopify
// says does NOT match the Ajax cart token and does NOT appear on the order, so it is a WEAK
// key for re-linking a session to itself, never a join key to an order. Order correlation is
// done on checkout_token (see checkout_started above + the order webhook).
function cartKey() {
  try {
    var c = (typeof init !== "undefined" && init && init.data && init.data.cart) || null;
    return (c && (c.id || c.token)) || null;
  } catch (e) { return null; }
}

// Browse signal. The variant payload carries the product image + url natively, so the
// browse-abandonment template's image header + product link bind with no server lookup.
analytics.subscribe("product_viewed", function (event) {
  var v = (event.data && event.data.productVariant) || {};
  var prod = v.product || {};
  var price = v.price || {};
  var url = prod.url || null; // Shopify gives a path like /products/ghost-rc-drift-car
  var path = url ? String(url).split("?")[0] : null;
  var handle = null;
  if (path) {
    var mm = path.match(/\/products\/([^\/]+)/);
    if (mm) handle = mm[1];
  }
  post("product_viewed", {
    properties: {
      product_name: prod.title || v.title || null,
      variant_id: v.id || null,
      sku: v.sku || null,
      price: num(price.amount),
      currency: price.currencyCode || null,
      product_handle: handle,
      product_url: path ? ("https://www.legendoftoys.com" + path) : null,
      product_image_url: (v.image && v.image.src) || null
    }
  }, event);
});

analytics.subscribe("product_added_to_cart", function (event) {
  var line = (event.data && event.data.cartLine) || {};
  var m = line.merchandise || {};
  var prod = m.product || {};
  var cost = (line.cost && line.cost.totalAmount) || {};
  post("add_to_cart", {
    cart_id: cartKey(),
    properties: {
      cart_id: cartKey(),
      product_title: prod.title || m.title || null,
      variant_id: m.id || null,
      sku: m.sku || null,
      quantity: num(line.quantity),
      price: num(cost.amount)
    }
  }, event);
});
