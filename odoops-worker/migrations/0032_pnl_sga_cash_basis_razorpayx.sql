-- 0032 (S396, 2026-09-22) — SG&A on a CASH basis from RazorpayX payslips (Afshaan, decisions §S393).
-- New pnl_sga_source value 'podium_cash'. Staff salary for month M is paid on the 1st–3rd of M+1,
-- so SG&A for calendar month M = Σ podium.payouts (source 'razorpayx') for payroll month M−1.
-- A month whose payroll month has NO synced payslips falls back to the CTC/12 accrual run for
-- M−1 (Afshaan 2026-09-22, option a) and says so via f_pnl_sga_basis — the basis travels with
-- the number, never silently. 'podium' (accrual) and 'manual' are unchanged.

CREATE OR REPLACE FUNCTION sales.f_pnl_sga_basis(p_from date, p_to date)
 RETURNS TABLE(month date, basis text, payroll_month text, payslips integer, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'sales', 'public'
AS $function$
  WITH months AS (SELECT generate_series(date_trunc('month',p_from), date_trunc('month',p_to), interval '1 month')::date m),
  paid AS (
    SELECT mo.m, to_char(mo.m - interval '1 month','YYYY-MM') pm,
           (SELECT count(*)::int FROM podium.payouts p
             WHERE p.source='razorpayx' AND p.period_key = to_char(mo.m - interval '1 month','YYYY-MM')) n,
           (SELECT sum(p.amount) FROM podium.payouts p
             WHERE p.source='razorpayx' AND p.period_key = to_char(mo.m - interval '1 month','YYYY-MM')) amt
    FROM months mo
  )
  SELECT m,
         CASE WHEN n > 0 THEN 'cash_razorpayx' ELSE 'accrual_fallback' END,
         pm, n,
         CASE WHEN n > 0 THEN ROUND(amt)
              ELSE ROUND(sales.f_podium_salary_run((m - interval '1 month')::date)) END
  FROM paid ORDER BY m;
$function$;

CREATE OR REPLACE FUNCTION sales.f_pnl_sga(p_from date, p_to date)
 RETURNS TABLE(month date, sga numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'sales', 'public'
AS $function$
  WITH months AS (SELECT generate_series(date_trunc('month',p_from), date_trunc('month',p_to), interval '1 month')::date m),
  src AS (SELECT COALESCE((SELECT value FROM sales.settings WHERE key='pnl_sga_source'),'manual') s)
  SELECT mo.m,
    CASE WHEN (SELECT s FROM src) = 'podium_cash'
      THEN (SELECT b.amount FROM sales.f_pnl_sga_basis(mo.m, mo.m) b)
    WHEN (SELECT s FROM src) = 'podium'
      THEN ROUND(sales.f_podium_salary_run(mo.m))
      ELSE ROUND(COALESCE((SELECT SUM(amount_inr) FROM sales.pnl_manual
                           WHERE channel_key='all' AND line_key='sga' AND date_trunc('month',month)=mo.m),0))
    END
  FROM months mo ORDER BY mo.m;
$function$;

REVOKE ALL ON FUNCTION sales.f_pnl_sga_basis(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales.f_pnl_sga_basis(date, date) TO service_role;
