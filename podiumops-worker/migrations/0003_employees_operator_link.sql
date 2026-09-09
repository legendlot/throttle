-- ============================================================================
-- 0003_employees_operator_link
--
-- ⚠️ THIS MIGRATION DOCUMENTS SCHEMA THAT IS ALREADY LIVE. It was applied to
-- lot-production ad hoc, with no migration file, some time before 2026-09-09.
-- Written retroactively (S363) so the repo stops disagreeing with the database.
-- It is written to be IDEMPOTENT and is therefore safe to run against a database
-- that already has these objects — which production does. Run it only to bring a
-- branch/local copy in line.
--
-- WHY THE COLUMN EXISTS
-- `podium.employees` (salaried staff, costed to SG&A) and `public.operators`
-- (factory floor, costed to COGS labour via podium.factory_pay) are two records
-- of two different populations — but a handful of people are legitimately in
-- both. Odo's SG&A run must not charge such a person twice, so it EXCLUDES any
-- employee who is also an active, paid operator.
--
-- That exclusion originally matched on NAME, which is unsafe in both directions:
-- a coincidental match silently deletes a real salary from SG&A, and a spelling
-- variant silently double-counts. `operator_id` replaces the guess with a stated
-- fact. As of 2026-09-09 both `sales.f_podium_salary_run` and
-- `sales.f_podium_salary_coverage` join on `e.operator_id` and no longer look at
-- names; `sales.f_podium_link_candidates()` proposes pairings for a human to
-- confirm, and never writes.
--
-- ⚠️ POPULATE IT DELIBERATELY, NEVER BY A NAME-MATCHING BACKFILL. Measured
-- 2026-09-09: 122 active operators carry factory_pay, exactly 1 is linked, and 6
-- more share a FIRST NAME with an active salaried employee — all six are
-- coincidences (floor workers vs office managers, different surnames), and a
-- backfill on name similarity would have wrongly excluded six real salaries from
-- SG&A. `f_podium_link_candidates()` requires a full exact name match precisely
-- because of this, and it currently returns zero rows.
-- ============================================================================

-- The link itself. NULL is the normal state: most employees are not operators
-- and most operators are not employees.
ALTER TABLE podium.employees
  ADD COLUMN IF NOT EXISTS operator_id uuid;

-- ON DELETE SET NULL, deliberately: retiring an operator row must never cascade
-- into deleting an employment record. The link is the weaker of the two facts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_operator_id_fkey'
  ) THEN
    ALTER TABLE podium.employees
      ADD CONSTRAINT employees_operator_id_fkey
      FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
  END IF;
END $$;

-- UNIQUE, so one operator cannot be claimed by two employees. Partial on NOT
-- NULL — a plain UNIQUE would be satisfied by many NULLs in Postgres anyway, but
-- stating it partial documents the intent and keeps the index small.
CREATE UNIQUE INDEX IF NOT EXISTS employees_operator_id_uidx
  ON podium.employees (operator_id)
  WHERE operator_id IS NOT NULL;

-- No GRANT needed: podiumops and odoops both connect as service_role, which
-- already holds table-level privileges on podium.employees from 0001.
