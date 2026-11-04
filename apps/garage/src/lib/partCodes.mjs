// Reads part codes out of a pasted list: one per line (or comma-separated), the first code-shaped word
// on each, so "1. FL-PP-10 : T-Connector 10-12 pcs = 968" gives FL-PP-10 alone. Upper-cased, each code
// once, in paste order. Word and Excel dashes are read as hyphens: left alone, HW-SC-23-6–BK would cut
// to the real code HW-SC-23-6 and count the wrong part. The worker refuses a code with no stock row.
const PART_CODE = /[A-Z0-9]+(?:-+[A-Z0-9]+(?:\.[A-Z0-9]+)*)+/i;
const DASHES = /[‐-―−]/g;

export function parsePartCodes(raw) {
  const codes = String(raw || '').replace(DASHES, '-').split(/[\r\n,;]+/)
    .map(seg => (seg.match(PART_CODE) || [])[0]).filter(Boolean).map(c => c.toUpperCase());
  return [...new Set(codes)];
}
