-- 0031 — product-image catalog cache (S230, v3 image-header cart template).
-- title → storefront image URL, keyed on the Shopify product TITLE (the exact string
-- Shopflo sends in cart_product_names). Lazily refreshed by the shopflo webhook handler
-- from the PUBLIC storefront catalog (products.json — no admin scope needed): a cache
-- miss re-pulls the whole catalog (~31 products) and upserts every row.
CREATE TABLE IF NOT EXISTS comms.product_images (
  title text PRIMARY KEY,
  image_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE comms.product_images ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.product_images TO service_role;
