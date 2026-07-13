-- deliveryops_edd_cache_v1 — cache for the in-house PDP delivery-date checker.
-- Target: Supabase project jkxcnjabmrkteanzoofj (same project as courierops / lotopsproxy).
-- Keyed on (pincode, cod). Stores transit_days (NOT an absolute date) so the displayed
-- delivery date is recomputed per request against "today" and never goes stale overnight.
-- source ∈ {'delhivery','fallback','unserviceable'}; transit_days is null unless source='delhivery'.
-- Apply via the Supabase MCP apply_migration (or SQL editor) at the deploy/smoke step.

create table if not exists public.delivery_edd_cache (
  pincode       text    not null,
  cod           boolean not null default false,
  serviceable   boolean not null,
  cod_available boolean not null default false,
  source        text    not null,
  transit_days  integer,
  raw           jsonb,
  fetched_at    timestamptz not null default now(),
  primary key (pincode, cod)
);
