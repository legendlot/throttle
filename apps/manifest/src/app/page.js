'use client';
import { RequireAuth } from '@throttle/auth';
import ManifestApp from '../mf/ManifestApp.js';

export default function Home() {
  return (
    <RequireAuth>
      <ManifestApp />
    </RequireAuth>
  );
}
