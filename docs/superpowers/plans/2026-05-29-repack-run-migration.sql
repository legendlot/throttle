-- =====================================================================
-- Repack Run (Channel Swap) — Phase 1 migration
-- Plan: 05_Throttle/docs/superpowers/plans/2026-05-29-repack-run.md (RESUME HERE)
-- Project: lot-production  (ref jkxcnjabmrkteanzoofj)
-- Created: 2026-05-29 (Session 86). Schema CONFIRMED + migrations APPROVED.
--
-- RUN ORDER MATTERS. Step 1 (enum adds) MUST commit before anything could
-- use the new values. psql autocommits each top-level statement when no
-- explicit BEGIN is open, so running this file straight through is safe —
-- do NOT wrap it in a single BEGIN/COMMIT.  ('ALTER TYPE ... ADD VALUE'
-- also cannot be followed by a use of that value in the same txn.)
--
-- Step 2 tables do NOT reference the new enum values (from_channel /
-- to_channel / status are plain text+CHECK), so they are independent of
-- Step 1 — but keep the ordering anyway to match the approved plan.
-- =====================================================================


-- ── STEP 1 — enum values (standalone, autocommit each) ───────────────
ALTER TYPE public.unit_status   ADD VALUE IF NOT EXISTS 'in_repack';
ALTER TYPE public.activity_type ADD VALUE IF NOT EXISTS 'REPACK_IN';
ALTER TYPE public.activity_type ADD VALUE IF NOT EXISTS 'REPACK_OUT';


-- ── STEP 2 — sequence + tables + RLS + grants ───────────────────────
INSERT INTO store.sequences (name, current_val) VALUES ('repack', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE store.repack_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_no        text NOT NULL UNIQUE,                       -- RPK-NNN
  product       text NOT NULL,
  variant_model text,
  colour        text,
  from_channel  text NOT NULL CHECK (from_channel IN ('retail','ecom')),
  to_channel    text NOT NULL CHECK (to_channel   IN ('retail','ecom')),
  target_qty    integer NOT NULL CHECK (target_qty > 0),
  status        text NOT NULL DEFAULT 'Open'
                  CHECK (status IN ('Open','In Progress','Completed','Cancelled')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT repack_runs_diff_channel CHECK (from_channel <> to_channel)
);
CREATE INDEX repack_runs_status_idx  ON store.repack_runs (status);
CREATE INDEX repack_runs_product_idx ON store.repack_runs (product);

CREATE TABLE public.channel_swap_history (   -- append-only, one row per car swapped
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repack_run_id      bigint NOT NULL,         -- text-join to store.repack_runs.id (no cross-schema FK)
  repack_run_no      text,
  car_upc            text NOT NULL,
  paired_remote_upc  text,
  from_channel       text NOT NULL,
  to_channel         text NOT NULL,
  old_box_id         uuid,
  new_box_id         uuid,
  old_batch_label    text,
  new_batch_label    text,
  repack_in_scan_id  uuid,
  repack_out_scan_id uuid,
  operator_id        text,
  line               text,
  repacked_in_at     timestamptz,
  repacked_out_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_swap_history_run_idx ON public.channel_swap_history (repack_run_id);
CREATE INDEX channel_swap_history_car_idx ON public.channel_swap_history (car_upc);

ALTER TABLE store.repack_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_swap_history  ENABLE ROW LEVEL SECURITY;

GRANT ALL ON store.repack_runs           TO service_role;
GRANT ALL ON public.channel_swap_history TO service_role;


-- ── VERIFICATION (read-only — run after the above) ──────────────────
-- 1. Enum values present?
SELECT 'unit_status' AS enum, enumlabel
  FROM pg_enum WHERE enumtypid = 'public.unit_status'::regtype  AND enumlabel = 'in_repack'
UNION ALL
SELECT 'activity_type', enumlabel
  FROM pg_enum WHERE enumtypid = 'public.activity_type'::regtype AND enumlabel IN ('REPACK_IN','REPACK_OUT')
ORDER BY 1,2;
-- expect 3 rows: in_repack / REPACK_IN / REPACK_OUT

-- 2. Sequence seeded?
SELECT name, current_val FROM store.sequences WHERE name = 'repack';
-- expect repack | 0

-- 3. Tables exist with expected column counts?
SELECT table_schema, table_name, count(*) AS cols
  FROM information_schema.columns
 WHERE (table_schema='store'  AND table_name='repack_runs')
    OR (table_schema='public' AND table_name='channel_swap_history')
 GROUP BY 1,2 ORDER BY 1,2;
-- expect public.channel_swap_history | 17  and  store.repack_runs | 13
