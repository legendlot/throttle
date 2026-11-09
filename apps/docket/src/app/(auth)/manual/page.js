'use client';
import { Manual } from '@throttle/ui';
import manual from '../../../data/manual.json';

// P7: shell fit only. `.dk-manual` fills the canvas below the top bar so the manual's own
// rail + article scroll independently (globals.css); the content is unchanged.
export default function ManualPage() {
  return <div className="dk-manual"><Manual manual={manual} bleed={false} /></div>;
}
