// Hiring C3 — the CTC calculator (src/offer-calc.js), against the rule sets AS SEEDED in
// migrations/0008_hiring_offers.sql (read out of the file, so the test and the migration can't drift).
// Synthetic figures only — never a real person's salary in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeAnnexure, bandCheck, needsApproval, componentsContract, stateCode, variableLineLabel, BONUS_TYPES } from '../src/offer-calc.js';
import { VARIABLE_FREQUENCIES } from '../src/hiring.js';

const sql = readFileSync(new URL('../migrations/0008_hiring_offers.sql', import.meta.url), 'utf8');
function seededRules(code) {
  const m = sql.match(new RegExp(`\\('${code}',[^$]*\\$rules\\$([\\s\\S]*?)\\$rules\\$`));
  assert.ok(m, `rule set ${code} seeded in 0008`);
  return JSON.parse(m[1]);
}
const R25 = seededRules('IN-2025');
const R26 = seededRules('IN-2026-09');

const byKey = (a) => Object.fromEntries(a.lines.map(l => [l.key, l]));
const sal = (o) => ({ mode: 'salary', work_state: 'Karnataka', variable_label: 'variable pay', ...o });

test('IN-2025: PF capped at 1,800/month, PT 200 / 2,400, the letters\' structure', () => {
  const a = computeAnnexure(sal({ fixed_annual: 450000, variable_annual: 50000 }), R25);
  const L = byKey(a);
  assert.deepEqual(a.lines.map(l => l.label), ['Basic Salary', 'House Rent Allowance', 'Special Allowance',
    'Travel Reimbursement', 'Telephone Reimbursement', 'Gross Total', "Employer's PF Contribution",
    "Employee's PF Contribution", 'Professional Tax', 'Total Fixed', 'Variable', 'Total CTC']);
  assert.deepEqual([L.basic.annual, L.basic.monthly], [225000, 18750]);
  assert.deepEqual([L.hra.annual, L.hra.monthly], [112500, 9375]);
  assert.deepEqual([L.travel.annual, L.travel.monthly], [30000, 2500]);
  assert.deepEqual([L.telephone.annual, L.telephone.monthly], [7500, 625]);
  assert.deepEqual([L.employer_pf.annual, L.employer_pf.monthly], [21600, 1800]);
  assert.deepEqual([L.employee_pf.annual, L.employee_pf.monthly], [21600, 1800]);
  assert.deepEqual([L.professional_tax.annual, L.professional_tax.monthly], [2400, 200]);
  assert.deepEqual([L.gross_total.annual, L.gross_total.monthly], [404400, 33700]);
  assert.deepEqual([L.special.annual, L.special.monthly], [29400, 2450]);
  assert.deepEqual([L.total_fixed.annual, L.total_fixed.monthly], [450000, 37500]);
  assert.deepEqual([L.variable.annual, L.variable.monthly], [50000, 4167]);
  assert.deepEqual([L.total_ctc.annual, L.total_ctc.monthly], [500000, 41667]);
  assert.equal(a.in_hand_monthly, 33700, 'in-hand = Gross Total / 12');
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(a.totals, { gross_total: 404400, total_fixed: 450000, variable: 50000, total_ctc: 500000 });
  // Deductions block arithmetic lands on the in-hand figure.
  assert.equal(a.deductions.reduce((s, d) => s + d.monthly, 0), a.in_hand_monthly);
});

test('IN-2026-09: PF 12% of min(Basic/12, 25,000); PT 200/month + 300 in February (2,500/yr)', () => {
  const a = computeAnnexure(sal({ fixed_annual: 450000, variable_annual: 50000 }), R26);
  const L = byKey(a);
  assert.deepEqual([L.employer_pf.annual, L.employer_pf.monthly], [27000, 2250]);
  assert.deepEqual([L.professional_tax.annual, L.professional_tax.monthly], [2500, 200]);
  assert.deepEqual([L.gross_total.annual, L.gross_total.monthly], [393500, 32792]);
  assert.deepEqual([L.special.annual, L.special.monthly], [18500, 1542]);
  assert.ok(a.notes.some(n => /300 in February/.test(n)));
  assert.equal(a.totals.total_ctc, 500000);
});

test('IN-2026-09: wages under 25,000/month → no PT; above the ESI ceiling → no ESI', () => {
  const a = computeAnnexure(sal({ fixed_annual: 288000, variable_annual: 0 }), R26);
  const L = byKey(a);
  assert.equal(a.statutory.esi_applies, false);
  assert.equal(L.employer_esi, undefined);
  assert.deepEqual([L.professional_tax.annual, L.professional_tax.monthly], [0, 0]);
  assert.deepEqual([L.employer_pf.annual, L.employer_pf.monthly], [17280, 1440]);
  assert.deepEqual([L.gross_total.annual, L.gross_total.monthly], [253440, 21120]);
  assert.deepEqual([L.special.annual, L.special.monthly], [13440, 1120]);
  assert.equal(L.variable, undefined, 'no variable line when there is no variable');
  assert.equal(L.total_ctc.annual, 288000);
});

test('ESI applies at or under 21,000/month; employer ESI sits inside CTC', () => {
  const F = 204000;
  const a = computeAnnexure(sal({ fixed_annual: F }), R26);
  const L = byKey(a);
  assert.equal(a.statutory.esi_applies, true);
  assert.deepEqual(a.lines.slice(6, 11).map(l => l.key), ['employer_pf', 'employee_pf', 'professional_tax', 'employer_esi', 'employee_esi']);
  // W = F/12 − employer PF = 17,000 − 1,020 = 15,980; W' = W / 1.0325; employer ESI = W − W'.
  const W = F / 12 - 1020, Wp = W / 1.0325;
  assert.equal(L.employer_esi.monthly, Math.round(0.0325 * Wp));
  assert.equal(L.employee_esi.monthly, Math.round(0.0075 * Wp));
  assert.ok(Math.abs(0.0325 * Wp - (W - Wp)) < 1e-9, 'employer ESI + its wage = statutory wages');
  const gross = F - 12240 - 12240 - 12 * 0.0325 * Wp - 12 * 0.0075 * Wp;
  assert.equal(L.gross_total.annual, Math.round(gross));
  assert.equal(a.in_hand_monthly, Math.round(gross / 12));
  assert.equal(L.total_ctc.annual, F, 'CTC is still the fixed figure — ESI is inside it');
});

test('PF opt-out: refused at or under the ceiling, allowed above it (no PF lines)', () => {
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 450000, pf_opt_out: true }), R26), { error: 'pf_opt_out_not_eligible' });
  const a = computeAnnexure(sal({ fixed_annual: 450000, pf_opt_out: true }), R25);
  const L = byKey(a);
  assert.equal(L.employer_pf, undefined);
  assert.equal(L.employee_pf, undefined);
  assert.deepEqual([L.gross_total.annual, L.gross_total.monthly], [447600, 37300]);
  assert.equal(a.deductions.reduce((s, d) => s + d.monthly, 0), a.in_hand_monthly);
});

test('special allowance below zero and the 50% wage rule are refused', () => {
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 450000 }), { ...R25, travel_div: 2 }), { error: 'special_negative' });
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 450000 }), { ...R25, basic_pct_of_fixed: 0.4 }), { error: 'wage_rule' });
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 0 }), R25), { error: 'bad_fixed_annual' });
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 450000.5 }), R25), { error: 'bad_fixed_annual' });
  assert.deepEqual(computeAnnexure(sal({ fixed_annual: 450000, variable_annual: -1 }), R25), { error: 'bad_variable_annual' });
});

test('unknown work state → PT 0 with a warning', () => {
  const a = computeAnnexure(sal({ fixed_annual: 450000, work_state: 'Atlantis' }), R26);
  assert.equal(byKey(a).professional_tax.annual, 0);
  assert.deepEqual(a.warnings, ['pt_state_unknown']);
  assert.equal(stateCode('Karnataka'), 'KA');
  assert.equal(stateCode(' ka '), 'KA');
});

test('rounding: annual and monthly columns are rounded independently (as the letters)', () => {
  const a = computeAnnexure(sal({ fixed_annual: 470000 }), R25);
  const L = byKey(a);
  const earnings = ['basic', 'hra', 'special', 'travel', 'telephone'];
  assert.equal(L.gross_total.annual, 424400);
  assert.equal(earnings.reduce((s, k) => s + L[k].annual, 0), 424399, 'rounded parts need not sum to the rounded total');
  assert.deepEqual([L.travel.annual, L.travel.monthly], [31333, 2611]);
  assert.deepEqual([L.telephone.annual, L.telephone.monthly], [7833, 653]);
  assert.deepEqual([L.special.annual, L.special.monthly], [32733, 2728]);
});

test('incentive label', () => {
  const a = computeAnnexure(sal({ fixed_annual: 450000, variable_annual: 30000, variable_label: 'incentive pay' }), R25);
  assert.equal(byKey(a).variable.label, 'Incentive');
  assert.equal(variableLineLabel('variable pay'), 'Variable');
});

test('stipend mode: monthly × months; no PF / PT / ESI / variable', () => {
  const a = computeAnnexure({ mode: 'stipend', stipend_monthly: 15000, internship_months: 6, work_state: 'KA' }, R26);
  assert.equal(a.mode, 'stipend');
  assert.deepEqual(a.lines, [{ key: 'stipend', label: 'Stipend', kind: 'total', monthly: 15000, annual: 90000 }]);
  assert.equal(a.totals.total_ctc, 90000);
  assert.deepEqual(a.deductions, []);
  assert.deepEqual(computeAnnexure({ mode: 'stipend', stipend_monthly: 15000, internship_months: 0 }, R26), { error: 'bad_internship_months' });
  assert.deepEqual(computeAnnexure({ mode: 'stipend', stipend_monthly: 0, internship_months: 3 }, R26), { error: 'bad_stipend_monthly' });
});

test('bandCheck: total CTC + every one-time extra', () => {
  const band = { band_min: 400000, band_max: 600000 };
  assert.equal(bandCheck(500000, [0, 0], band), 'in_band');
  assert.equal(bandCheck(600000, 0, band), 'in_band', 'max is inclusive');
  assert.equal(bandCheck(600001, 0, band), 'above_band');
  assert.equal(bandCheck(350000, 0, band), 'below_band');
  assert.equal(bandCheck(500000, [25000, 0], band), 'extras', 'any extra needs approval, even inside the band');
  assert.equal(bandCheck(590000, [25000], band), 'above_band', 'extras count toward the band');
  assert.equal(bandCheck(350000, [10000], band), 'extras');
  assert.equal(bandCheck('500000', ['0'], { band_min: '400000', band_max: '600000' }), 'in_band', 'PostgREST strings');
  assert.equal(needsApproval('above_band'), true);
  assert.equal(needsApproval('extras'), true);
  assert.equal(needsApproval('below_band'), false);
  assert.equal(needsApproval('in_band'), false);
});

test('componentsContract: the payouts keys, fixed', () => {
  const a = computeAnnexure(sal({ fixed_annual: 450000, variable_annual: 50000 }), R25);
  const c = componentsContract(a, { designation: 'Analyst', variable_frequency: 'half-yearly' });
  assert.deepEqual(Object.keys(c).sort(), ['annexure', 'bonus_type', 'designation', 'fixed_yearly', 'gross_yearly',
    'monthly_fixed', 'monthly_variable', 'variable_yearly']);
  assert.equal(c.monthly_fixed, 37500);
  assert.equal(c.monthly_variable, 0, 'half-yearly variable is paid as variable_yearly / 2');
  assert.equal(c.fixed_yearly, 450000);
  assert.equal(c.variable_yearly, 50000);
  assert.equal(c.gross_yearly, 500000, 'gross_yearly = total CTC, as the live rows');
  assert.equal(c.bonus_type, 'Half-Yearly');
  const m = componentsContract(a, { designation: 'Analyst', variable_frequency: 'monthly' });
  assert.equal(m.monthly_variable, 4166.67);
  assert.equal(m.bonus_type, 'Monthly');
  const s = componentsContract(computeAnnexure({ mode: 'stipend', stipend_monthly: 15000, internship_months: 6 }, R26), { designation: 'Intern' });
  assert.equal(s.monthly_fixed, 15000);
  assert.equal(s.monthly_stipend, 15000, 'monthly_stipend — the live intern key');
  assert.equal('stipend_monthly' in s, false);
  assert.equal(s.bonus_type, null);
});

test('componentsContract: only the bonus types the payouts reader handles', () => {
  assert.deepEqual(Object.values(BONUS_TYPES).sort(), ['Half-Yearly', 'Monthly']);
  for (const f of VARIABLE_FREQUENCIES) assert.ok(BONUS_TYPES[f], `${f} maps to a payouts bonus_type`);
  assert.deepEqual(VARIABLE_FREQUENCIES, ['half-yearly', 'monthly']);
  const a = computeAnnexure(sal({ fixed_annual: 450000, variable_annual: 50000 }), R25);
  assert.equal(componentsContract(a, { variable_frequency: 'quarterly' }).bonus_type, null, 'never an unknown type');
});
