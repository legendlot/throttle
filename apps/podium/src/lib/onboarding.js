// J2 — onboarding + profile completion: vocabularies, form sections + error copy for /welcome, /onboarding, the
// employee-page cards and the two admin pages. Every gate and every rule is the worker's
// (podiumops-worker src/onboarding.js); these are labels only.

export const OB_OWNERS = [
  { id: 'employee', label: 'You / the joiner' },
  { id: 'it',       label: 'IT' },
  { id: 'manager',  label: 'Manager' },
  { id: 'hr',       label: 'HR' },
];
export const OB_AUTO_LABELS = {
  profile: 'Live: profile complete',
  documents: 'Live: documents uploaded',
  policies: 'Live: policies acknowledged',
  login: 'Live: LOT login linked',
  it_kit: 'Live: Snorkel assets in their name',
  probation_date: 'Live: probation end date set',
};
export const OB_STATE = {
  done: { tone: 'ok', label: 'Done' },
  na: { tone: 'neutral', label: 'N/A' },
  open: { tone: 'warn', label: 'Open' },
  unverifiable: { tone: 'info', label: 'Check by hand' },
};
export const DOC_TYPE_LABELS = {
  id_proof: 'ID proof', address_proof: 'Address proof', bank_details: 'Bank details (cancelled cheque / passbook)',
  education_cert: 'Education certificate', other: 'Other',
};
export const CHANGE_FIELD_LABELS = { pan_number: 'PAN', bank_account_number: 'Bank account number', bank_ifsc: 'Bank IFSC', bank_account_name: 'Name on the bank account' };
export const PROTECTED_FIELDS = Object.keys(CHANGE_FIELD_LABELS);
// PAN is its own change; the three bank fields are ONE "Bank details" change, decided / withdrawn together.
export const CHANGE_GROUP_LABELS = { pan: 'PAN', bank: 'Bank details' };
export const groupOf = (field) => (field === 'pan_number' ? 'pan' : 'bank');

// The /welcome form. `src` = where the value lives in getMyProfile ('employee' | 'private').
export const PROFILE_SECTIONS = [
  { id: 'personal', title: 'Personal', fields: [
    { key: 'preferred_name', label: 'Preferred name', src: 'employee' },
    { key: 'date_of_birth', label: 'Date of birth', src: 'employee', type: 'date', required: true },
    { key: 'gender', label: 'Gender', src: 'employee', type: 'gender', required: true },
    { key: 'blood_group', label: 'Blood group', src: 'employee', type: 'blood' },
    { key: 'pan_number', label: 'PAN', src: 'employee', required: true, placeholder: 'ABCDE1234F', upper: true },
  ] },
  { id: 'contact', title: 'Contact & emergency', fields: [
    { key: 'personal_email', label: 'Personal email', src: 'employee', type: 'email', required: true },
    { key: 'phone', label: 'Mobile', src: 'employee', type: 'tel', required: true, placeholder: '10 digits' },
    { key: 'emergency_contact_name', label: 'Emergency contact name', src: 'employee', required: true },
    { key: 'emergency_contact_phone', label: 'Emergency contact mobile', src: 'employee', type: 'tel', required: true },
  ] },
  { id: 'address', title: 'Address', fields: [
    { key: 'current_address', label: 'Current address', src: 'private', type: 'textarea', required: true },
    { key: 'permanent_address', label: 'Permanent address (if different)', src: 'private', type: 'textarea' },
  ] },
  { id: 'bank', title: 'Bank (salary account)', fields: [
    { key: 'bank_account_name', label: 'Name on the account', src: 'private' },
    { key: 'bank_account_number', label: 'Account number', src: 'private', required: true, placeholder: '9 to 18 digits' },
    { key: 'bank_ifsc', label: 'IFSC', src: 'private', required: true, placeholder: 'ABCD0123456', upper: true },
  ] },
  { id: 'statutory', title: 'Statutory (if you have them)', fields: [
    { key: 'pf_uan', label: 'PF UAN', src: 'private', placeholder: '12 digits' },
    { key: 'esic_number', label: 'ESIC number', src: 'private' },
  ] },
  { id: 'previous', title: 'Previous employer this financial year (optional)', salary: true, fields: [
    { key: 'fy_label', label: 'Financial year', src: 'private', placeholder: '2026-27' },
    { key: 'cur_fy_taxable_outside', label: 'Taxable salary paid this FY outside XPayroll (₹)', src: 'private', type: 'amount' },
    { key: 'cur_fy_exemptions', label: 'Exemptions this FY (₹)', src: 'private', type: 'amount' },
    { key: 'cur_fy_tds', label: 'TDS deducted this FY (₹)', src: 'private', type: 'amount' },
    { key: 'past_taxable_salary', label: 'Past taxable salary (₹)', src: 'private', type: 'amount' },
    { key: 'past_tds', label: 'Past TDS (₹)', src: 'private', type: 'amount' },
  ] },
];

const COPY = {
  no_employee: 'Your login is not linked to an employee profile yet — ask HR',
  invalid_fields: 'Some fields need fixing',
  cannot_clear_protected: 'PAN and bank details cannot be cleared once filled — enter the new value to request a change',
  forbidden: 'You cannot do this here',
  forbidden_item: 'Only HR — or the manager, for manager lines — can set this line',
  set_automatically: 'This line is checked automatically and is already done',
  auto_line_open: 'This line is checked automatically — fix the source instead of ticking it',
  unverifiable_note_required: 'Say how it was verified',
  na_not_allowed: 'This line cannot be marked N/A',
  na_note_required: 'Say why this line does not apply',
  onboarding_not_open: 'This onboarding is not open',
  onboarding_already_open: 'An onboarding is already open for this person',
  onboarding_already_complete: 'This person has already completed onboarding',
  onboarding_blocked: 'Required lines are still open',
  onboarding_incomplete: 'Required lines are still open',
  no_lines: 'The onboarding checklist has no active lines',
  cancel_reason_required: 'Say why (at least 5 characters)',
  change_request_not_pending: 'Already decided — reload',
  decision_note_required: 'Say why the change is rejected',
  own_change_request: 'Another HR person decides your own change request',
  change_request_changed: 'The person changed this request since you loaded it — reloaded, look again',
  upload_not_found: 'The upload did not arrive — pick the file and upload again',
  storage_check_failed: 'Could not check the upload right now — try again',
  audit_failed: 'The export could not be logged, so it was not produced — try again',
  bad_pan: 'PAN looks like ABCDE1234F',
  policy_version_stale: 'A newer version was published — reload and read it',
  policy_not_applicable: 'This policy does not apply to you',
  bad_policy: 'A policy needs a title and a PDF',
  bad_doc_type: 'Pick a document type',
  bad_file_type: 'Upload a PDF or an image (JPG, PNG, WEBP)',
  file_too_large: 'The file is over 15 MB',
  bad_file_size: 'The file is empty or over 15 MB',
  bad_line: 'Key (lowercase_with_underscores), title, owner and an offset between −60 and 365 days',
  live_check_failed: 'Could not check right now — try again',
  org_check_failed: 'Could not check the reporting line right now — try again',
};
export function obError(e, fallback = 'Something went wrong') {
  const msg = (e && e.message) || '';
  const code = msg.split(/[:\s]/)[0];
  return COPY[code] || msg || fallback;
}
