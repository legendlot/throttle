'use client';
import { DynoBoard } from '../board.js';

// /dyno/screen — Gate 1 of the creative throughput loop: the cheap ATC screen. One CBO campaign,
// many ads; judged on CTR / cost-per-ATC / CBO spend-share (Meta's budget allocation IS the verdict),
// NOT purchase ROAS. Survivors get promoted into the Experiments (proving) bucket.
export default function DynoScreenPage() {
  return <DynoBoard kind="screen" />;
}
