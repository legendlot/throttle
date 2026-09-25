-- S400 (2026-09-25) — applied live as product_handle_map_title_match_v1.
-- Category stage ④: a storefront-title alias for events that carry a title but no handle
-- (Shopflo add_to_cart / checkout_abandoned, pixel add_to_cart). House Crest resolved null on
-- 942 such events in the 14 days to 2026-09-25 and fell into the Cars journeys.
ALTER TABLE public.product_handle_map ADD COLUMN IF NOT EXISTS title_match text;
COMMENT ON COLUMN public.product_handle_map.title_match IS 'S400: lowercase substring of the storefront TITLE that pins this product when an event carries a title but no handle (commsops category stage 4). NULL = handle-only.';
UPDATE public.product_handle_map SET title_match = 'hogwarts house crest' WHERE handle = 'house-crest-edition';
NOTIFY pgrst, 'reload schema';
