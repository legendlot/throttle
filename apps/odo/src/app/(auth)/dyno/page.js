'use client';
import { DynoBoard } from './board.js';

// /dyno — the Experiments bucket (creative tests). Scaling lives at /dyno/scaling; both render
// the shared <DynoBoard> parametrised by kind.
export default function DynoPage() {
  return <DynoBoard kind="experiment" />;
}
