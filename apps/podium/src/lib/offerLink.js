// Podium O1 — shared vocabulary + the ONE place the offer-link API shapes are normalised.
// Doc types mirror the worker's LINK_DOC_TYPES (offerlink.js). If the worker's field names differ from the
// plan, reconcile here (and in the PUBLIC_* / STAFF_* helpers below), not in the pages.

export const LINK_DOC_TYPES = [
  { id: 'payslip', label: 'Latest payslip', required: false },
  { id: 'pan', label: 'PAN card', required: true },
  { id: 'id_proof', label: 'ID proof (Aadhaar / passport / driving licence)', required: true },
  { id: 'address_proof', label: 'Address proof', required: true },
  { id: 'relieving_letter', label: 'Relieving letter (previous employer)', required: false },
  { id: 'photo', label: 'Passport-size photo', required: true },
  { id: 'bank', label: 'Cancelled cheque', required: true },
  { id: 'education', label: 'Education certificate', required: false },
  { id: 'experience_letter', label: 'Experience letter', required: false },
];
export const docTypeLabel = (id) => LINK_DOC_TYPES.find(d => d.id === id)?.label || String(id || '').replace(/_/g, ' ');

export const DECLINE_FALLBACK = [
  ['compensation', 'Compensation'], ['role', 'The role'], ['location', 'Location'],
  ['another_offer', 'I accepted another offer'], ['personal', 'Personal reasons'], ['other', 'Other'],
];
// decline_reasons arrives as {code: label} or [{code,label}] — normalise to [[code,label]].
export function declineReasons(v) {
  if (Array.isArray(v)) return v.map(x => Array.isArray(x) ? x : [x.code || x.id, x.label]).filter(x => x[0]);
  if (v && typeof v === 'object') return Object.entries(v);
  return DECLINE_FALLBACK;
}

// Masked bank object -> display parts. Reads {bank_account_number (masked), bank_ifsc, bank_account_name, bank_name}.
export function bankView(b) {
  if (!b) return null;
  const acct = b.bank_account_number || b.masked || b.account_number || null;
  if (!acct && !b.bank_ifsc) return null;
  return { account: acct, ifsc: b.bank_ifsc || null, name: b.bank_account_name || null, bank: b.bank_name || null, editable: !!b.editable };
}

// getOffer.joining / public docs -> [{doc_type,label,required,docs:[{id,title,file_name,verified,verified_at,verified_by_name}],count,uploaded}]
export function joiningRows(v) {
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.entries(v).map(([doc_type, x]) => ({ doc_type, ...(Array.isArray(x) ? { docs: x } : x) })) : []);
  const by = Object.fromEntries(list.map(x => [x.doc_type || x.id, x]));
  return LINK_DOC_TYPES.map(t => {
    const x = by[t.id] || {};
    const docs = x.docs || x.items || [];
    const count = x.count != null ? Number(x.count) : docs.length;
    const verified = x.verified != null ? !!x.verified
      : x.verified_count != null ? (count > 0 && Number(x.verified_count) >= count)
      : (docs.length > 0 && docs.every(d => d.verified || d.verified_at));
    return { doc_type: t.id, label: x.label || t.label, required: x.required != null ? !!x.required : t.required, docs, count, uploaded: count > 0 || !!x.uploaded, verified };
  });
}

// emails: [{id, kind, status, to_email, cc_emails, sent_at, created_at, error, has_link, link_live}]
export const emailChecking = (e) => e.status === 'unknown' || e.status === 'sending';
