'use client';
// The review screen for everyone's own self-review and their reports' manager reviews (S396).
// Same forms as /appraisals/detail but never the calibration tools, and it stays in Reviews.
import { Suspense } from 'react';
import { Spinner } from '@throttle/ui';
import { DetailPage } from '../../appraisals/detail/page.js';

export default function Page() {
  return <Suspense fallback={<Spinner />}><DetailPage mode="review" /></Suspense>;
}
