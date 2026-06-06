'use client';
import { Manual } from '@throttle/ui';
import manual from '../../../data/manual.json';

export default function ManualPage() {
  return <Manual manual={manual} />;
}
