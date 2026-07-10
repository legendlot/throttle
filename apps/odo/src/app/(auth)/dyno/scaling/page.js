'use client';
import { DynoBoard } from '../board.js';

// /dyno/scaling — the Scaling bucket (graduated winners running for volume), physically separated
// from the Experiments board so experiment vs scaling spend never gets confused.
export default function DynoScalingPage() {
  return <DynoBoard kind="scale" />;
}
