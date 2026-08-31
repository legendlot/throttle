export const OPERATOR_ROLES = [
  { value: 'assembly',           label: 'Assembly' },
  { value: 'qc_inline',          label: 'QC Inline' },
  { value: 'qc_audit',           label: 'QC Audit' },
  { value: 'repair',             label: 'Repair' },
  { value: 'packing',            label: 'Packing' },
  { value: 'rtd',                label: 'RTD' },
  { value: 'store',              label: 'Store' },
  { value: 'supervisor',         label: 'Supervisor' },
  { value: 'line_manager',       label: 'Line Manager' },
  { value: 'production_manager', label: 'Production Manager' },
  { value: 'admin',              label: 'Admin' },
];

export const SCAN_ACTIVITIES = ['INW','QC_PASS','QC_FAIL','WKS_IN','WKS_OUT','PKG','PKG_OUT','RTO_IN'];

// ⚠️ CORRECTED 2026-08-31 (S324): was ['L1','L2','L3'] while the floor has run five lines for
// months — every distinct `store.production_runs.line_no`, including in the last 90 days, is
// one of these five.
// ⚠️ NOTHING IMPORTS THIS TODAY, and that is the interesting part: redline `new-run`,
// `line-setup` and `audit` each declare their OWN local list, all already correct at five (audit
// adds D1/D2/Store/Other, which is right for a QC finding and wrong for a run). Consumers
// routed AROUND the stale shared constant instead of fixing it, so it sat wrong and unnoticed
// while the worker carried the same stale three in three separate places.
// Kept and corrected rather than deleted so the next person who reaches for it gets the right
// answer — but note a "line" is not one list: a RUN is L1–L5, a DEVICE or SCAN adds D1/D2/SHARED,
// a QC AUDIT finding adds Store/Other. Match the list to what you are validating.
export const LINES = ['L1','L2','L3','L4','L5'];
