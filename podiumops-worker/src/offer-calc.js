// Hiring C3 — the offer-letter CTC calculator (PURE: no I/O). The statutory numbers are data — a rule
// set row in podium.offer_rule_sets, chosen by the offer's start date — and this module only applies
// them. Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c3-offers.md §2 · tests: test/offer-calc.test.mjs
// CTC always includes employer PF, employee PF and PT (decisions.md §S445-Hiring) — they are shown as
// deductions → estimated in-hand; do not move them out of CTC.
// Full precision inside; round to the rupee only in the output, annual and monthly columns rounded
// independently (as the letters in the mailbox do).

const r0 = (n) => Math.round(Number(n) + 0);   // +0: never a -0 in the output
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Work state (opening.location_state, a name or a code) → the key used in rules.pt.
const STATE_CODES = { karnataka: 'KA', ka: 'KA', maharashtra: 'MH', mh: 'MH', 'tamil nadu': 'TN', tn: 'TN',
  telangana: 'TG', tg: 'TG', delhi: 'DL', dl: 'DL' };
export function stateCode(s) {
  const k = String(s || '').trim().toLowerCase();
  return STATE_CODES[k] || (k ? k.toUpperCase() : null);
}

// "Variable" / "Incentive" — the annexure line label from the offer's free label ("incentive pay").
export function variableLineLabel(label) {
  return /^\s*incentive/i.test(String(label || '')) ? 'Incentive' : 'Variable';
}

function isNonNegInt(v) { return Number.isFinite(v) && v >= 0 && Math.round(v) === v; }

// → { mode, lines[], totals, deductions[], in_hand_monthly, warnings[], notes[] } or { error: code }.
export function computeAnnexure(input, rules) {
  const mode = input?.mode === 'stipend' ? 'stipend' : 'salary';
  if (!rules || typeof rules !== 'object') return { error: 'rules_missing' };
  if (mode === 'stipend') return stipendAnnexure(input);

  const F = Number(input.fixed_annual);
  const V = input.variable_annual == null || input.variable_annual === '' ? 0 : Number(input.variable_annual);
  if (!(isNonNegInt(F) && F > 0)) return { error: 'bad_fixed_annual' };
  if (!isNonNegInt(V)) return { error: 'bad_variable_annual' };

  const warnings = [];
  const notes = [];
  const basic = rules.basic_pct_of_fixed * F;
  const hra = rules.hra_pct_of_basic * basic;
  const travel = F / rules.travel_div;
  const telephone = F / rules.telephone_div;
  if (basic < rules.min_basic_pct_of_fixed * F) return { error: 'wage_rule' };

  // PF on PF wages = min(Basic/12, ceiling); employer share = employee share.
  const pf = rules.pf || {};
  const basicMonthly = basic / 12;
  const pfWages = Math.min(basicMonthly, pf.wage_ceiling_monthly);
  let erPfM = pf.rate * pfWages;
  let eePfM = erPfM;
  if (input.pf_opt_out) {
    // Opting out is allowed only above the ceiling (spec §C3: wages above the ceiling, not already a member).
    if (!(basicMonthly > pf.wage_ceiling_monthly)) return { error: 'pf_opt_out_not_eligible' };
    erPfM = 0; eePfM = 0;
  }

  // Statutory gross wages (monthly) W, before ESI.
  const W = F / 12 - erPfM;

  // ESI when W ≤ the ceiling; employer ESI sits inside CTC, so solve for the wage it applies to.
  const esi = rules.esi || {};
  let erEsiM = 0, eeEsiM = 0;
  const esiApplies = esi.wage_ceiling_monthly != null && W <= esi.wage_ceiling_monthly;
  if (esiApplies) {
    const wPrime = W / (1 + esi.employer_rate);
    erEsiM = esi.employer_rate * wPrime;
    eeEsiM = esi.employee_rate * wPrime;
  }

  // Professional Tax by work state.
  const sc = stateCode(input.work_state);
  const ptRule = sc ? (rules.pt || {})[sc] : null;
  let ptM = 0, ptA = 0;
  if (!ptRule) {
    warnings.push('pt_state_unknown');
  } else if (ptRule.type === 'flat') {
    ptM = ptRule.monthly; ptA = ptRule.annual;
  } else if (ptRule.type === 'slab') {
    if (W >= ptRule.threshold_monthly) {
      ptM = ptRule.monthly; ptA = ptRule.annual;
      if (ptRule.february != null && ptRule.february !== ptRule.monthly) notes.push(`Professional Tax is INR ${ptRule.february} in February.`);
    }
  } else {
    warnings.push('pt_rule_unknown');
  }

  const erPfA = erPfM * 12, eePfA = eePfM * 12, erEsiA = erEsiM * 12, eeEsiA = eeEsiM * 12;
  const gross = F - erPfA - eePfA - ptA - erEsiA - eeEsiA;
  const special = gross - basic - hra - travel - telephone;
  if (special < -1e-9) return { error: 'special_negative' };

  const line = (key, label, annual, monthly, kind = 'earning') => ({ key, label, kind, annual: r0(annual), monthly: r0(monthly) });
  const lines = [
    line('basic', 'Basic Salary', basic, basic / 12),
    line('hra', 'House Rent Allowance', hra, hra / 12),
    line('special', 'Special Allowance', special, special / 12),
    line('travel', 'Travel Reimbursement', travel, travel / 12),
    line('telephone', 'Telephone Reimbursement', telephone, telephone / 12),
    line('gross_total', 'Gross Total', gross, gross / 12, 'subtotal'),
  ];
  // Opted out of PF → no PF lines (as the mailbox letter for an opted-out hire).
  if (!input.pf_opt_out) {
    lines.push(line('employer_pf', "Employer's PF Contribution", erPfA, erPfM, 'contribution'));
    lines.push(line('employee_pf', "Employee's PF Contribution", eePfA, eePfM, 'contribution'));
  }
  // PT's monthly column shows the regular month (February's higher figure is a note).
  lines.push(line('professional_tax', 'Professional Tax', ptA, ptM, 'contribution'));
  if (esiApplies) {
    lines.push(line('employer_esi', 'Employer ESI Contribution', erEsiA, erEsiM, 'contribution'));
    lines.push(line('employee_esi', 'Employee ESI Contribution', eeEsiA, eeEsiM, 'contribution'));
  }
  lines.push(line('total_fixed', 'Total Fixed', F, F / 12, 'subtotal'));
  if (V > 0) lines.push(line('variable', variableLineLabel(input.variable_label), V, V / 12));
  lines.push(line('total_ctc', 'Total CTC', F + V, (F + V) / 12, 'total'));

  // Deductions → estimated monthly in-hand (decision 7): monthly fixed less everything inside CTC that
  // never reaches the bank account. Equals Gross Total / 12.
  const deductions = [
    { key: 'monthly_fixed', label: 'Monthly fixed (Total Fixed / 12)', monthly: r0(F / 12) },
  ];
  if (!input.pf_opt_out) {
    deductions.push({ key: 'employer_pf', label: "Less: Employer's PF", monthly: -r0(erPfM) });
    deductions.push({ key: 'employee_pf', label: "Less: Employee's PF", monthly: -r0(eePfM) });
  }
  deductions.push({ key: 'professional_tax', label: 'Less: Professional Tax', monthly: -r0(ptM) });
  if (esiApplies) {
    deductions.push({ key: 'employer_esi', label: 'Less: Employer ESI', monthly: -r0(erEsiM) });
    deductions.push({ key: 'employee_esi', label: 'Less: Employee ESI', monthly: -r0(eeEsiM) });
  }

  return {
    mode: 'salary',
    lines,
    totals: { gross_total: r0(gross), total_fixed: r0(F), variable: r0(V), total_ctc: r0(F + V) },
    statutory: { pf_wages_monthly: r2(pfWages), wages_monthly: r2(W), esi_applies: esiApplies, pt_state: sc },
    deductions,
    in_hand_monthly: r0(gross / 12),
    in_hand_note: 'Estimated, before income-tax TDS.',
    notes,
    warnings,
  };
}

function stipendAnnexure(input) {
  const S = Number(input.stipend_monthly);
  const n = Number(input.internship_months);
  if (!(isNonNegInt(S) && S > 0)) return { error: 'bad_stipend_monthly' };
  if (!(Number.isInteger(n) && n >= 1 && n <= 24)) return { error: 'bad_internship_months' };
  return {
    mode: 'stipend',
    months: n,
    lines: [{ key: 'stipend', label: 'Stipend', kind: 'total', monthly: r0(S), annual: r0(S * n) }],
    totals: { total_ctc: r0(S * n), stipend_monthly: r0(S) },
    statutory: null,
    deductions: [],
    in_hand_monthly: r0(S),
    in_hand_note: 'Estimated, before income-tax TDS.',
    notes: [],
    warnings: [],
  };
}

// Band check on TOTAL CTC + every one-time cash extra (decision 6). Above max or any extra → approval;
// below min → flagged only.
export function bandCheck(totalCtc, extras, band) {
  const ex = (Array.isArray(extras) ? extras : [extras]).reduce((s, v) => s + (Number(v) || 0), 0);
  const t = Number(totalCtc) + ex;
  if (band && band.band_max != null && t > Number(band.band_max)) return 'above_band';
  if (ex > 0) return 'extras';
  if (band && band.band_min != null && t < Number(band.band_min)) return 'below_band';
  return 'in_band';
}
export const needsApproval = (check) => check === 'above_band' || check === 'extras';

// The compensation_events.components keys the payouts screen reads (a FIXED contract — see the spec's
// "What already exists"). C3b writes this at joining; built now so the contract is pinned by a test.
// Half-yearly variable → monthly_variable 0 (payouts pay variable_yearly / 2), as the live rows do.
const BONUS_TYPES = { 'half-yearly': 'Half-Yearly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };
export function componentsContract(annexure, offer) {
  if (annexure?.mode === 'stipend') {
    const s = Number(annexure.totals.stipend_monthly);
    return {
      monthly_fixed: s, monthly_variable: 0, fixed_yearly: s * 12, variable_yearly: 0, gross_yearly: s * 12,
      bonus_type: null, designation: offer?.designation || null, stipend_monthly: s, annexure,
    };
  }
  const F = Number(annexure.totals.total_fixed);
  const V = Number(annexure.totals.variable || 0);
  const freq = String(offer?.variable_frequency || 'half-yearly').toLowerCase();
  return {
    monthly_fixed: r2(F / 12),
    monthly_variable: V > 0 && freq === 'monthly' ? r2(V / 12) : 0,
    fixed_yearly: F,
    variable_yearly: V,
    gross_yearly: F + V,
    bonus_type: V > 0 ? (BONUS_TYPES[freq] || null) : null,
    designation: offer?.designation || null,
    annexure,
  };
}
