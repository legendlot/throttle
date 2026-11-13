// Shared labels / option lists for Podium.

export const EMPLOYMENT_TYPES = [
  { id: 'full_time',  label: 'Full-time' },
  { id: 'part_time',  label: 'Part-time' },
  { id: 'intern',     label: 'Intern' },
  { id: 'contractor', label: 'Contractor' },
  { id: 'consultant', label: 'Consultant' },
];

export const EMPLOYEE_STATUSES = [
  { id: 'active',   label: 'Active',        color: 'var(--state-success-fg)' },
  { id: 'on_leave', label: 'On Leave',      color: 'var(--state-warning-fg)' },
  { id: 'notice',   label: 'Notice Period', color: 'var(--brand-orange)' },
  { id: 'exited',   label: 'Exited',        color: 'var(--text-3)' },
];

export const DOC_TYPES = [
  { id: 'resume',               label: 'Resume' },
  { id: 'offer_letter',         label: 'Offer Letter' },
  { id: 'employment_agreement', label: 'Employment Agreement' },
  { id: 'nda',                  label: 'NDA' },
  { id: 'education_cert',       label: 'Education Certificate' },
  { id: 'id_proof',             label: 'ID Proof' },
  { id: 'bank_details',         label: 'Bank Details' },
  { id: 'address_proof',        label: 'Address Proof' },
  { id: 'appraisal_letter',     label: 'Appraisal Letter' },
  { id: 'increment_letter',     label: 'Increment Letter' },
  { id: 'relieving_letter',     label: 'Relieving Letter' },
  { id: 'experience_letter',    label: 'Experience Letter' },
  { id: 'other',                label: 'Other' },
];

export const LEGAL_ENTITIES = ['Silverton Ventures', 'Fraternitas Ventures'];

export const GENDER_OPTIONS = [
  { id: 'm',     label: 'Male' },
  { id: 'f',     label: 'Female' },
  { id: 'other', label: 'Other' },
];
export const GENDER_LABELS = { m: 'Male', f: 'Female', other: 'Other' };

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Title / Level / Team (2026-11-14): a level reads "L4 · Manager"; `short` = the code only.
export function levelLabel(level, short = false) {
  if (!level?.code) return '';
  return short || !level.name ? level.code : `${level.code} · ${level.name}`;
}

// Two teams can share a name under different parents (NPD > Build, Category > Build): a sub-team reads "Parent - Child"
// everywhere a team is picked, matching the Google department label. `parent` = {name} from the worker's select, or found
// by parent_department_id in the same list.
export function teamLabel(d, list = []) {
  if (!d) return '';
  const p = d.parent?.name || (d.parent_department_id ? list.find(x => x.id === d.parent_department_id)?.name : null);
  return p ? `${p} - ${d.name}` : (d.name || '');
}
export function teamOptions(list = [], exceptId = null) {
  return (list || []).filter(d => d.id !== exceptId).map(d => ({ value: d.id, label: teamLabel(d, list) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function labelOf(list, id) {
  return list.find(x => x.id === id)?.label || id || '—';
}
export function statusMeta(id) {
  return EMPLOYEE_STATUSES.find(x => x.id === id) || { label: id || '—', color: 'var(--text-3)' };
}

export function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return String(d); }
}
export function fmtMoney(n, currency = 'INR') {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
}
export function tenure(dateJoined) {
  if (!dateJoined) return '—';
  const start = new Date(dateJoined);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return '—';
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y}y` : null, `${m}m`].filter(Boolean).join(' ');
}
