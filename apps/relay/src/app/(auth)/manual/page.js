'use client';
import { Manual } from '@throttle/ui';
import manual from '@/data/manual.json';

// The in-app System Manual. Same spine as the PDF (apps/relay/docs/manual), inlined at
// build time by scripts/build-manual-web.py — so the tab and the downloadable PDF can
// never drift. The generated src/data/manual.json and public/manual/*.pdf are COMMITTED:
// CI only runs `next build` and will not regenerate them.
export default function ManualPage() {
  return <Manual manual={manual} />;
}
