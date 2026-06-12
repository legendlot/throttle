'use client';
// Checklist item tag pill. Fixed vocabulary (RULE-DOCKET-009). Themed via CSS classes.
export const CHECKLIST_TAGS = ['Critical', 'QC', 'Deadline', 'Ongoing'];
const CLS = { Critical: 'tag-critical', QC: 'tag-qc', Deadline: 'tag-deadline', Ongoing: 'tag-ongoing' };
export function TagPill({ tag }) {
  if (!CHECKLIST_TAGS.includes(tag)) return null;
  return <span className={'cl-tag ' + (CLS[tag] || '')}>{tag}</span>;
}
export default TagPill;
