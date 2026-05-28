'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { KpiCard, Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';

export default function DashboardPage() {
  const { session } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getKpis', {}, session).then(setKpis).catch(e => setErr(e.message));
  }, [session]);

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!kpis) return <Spinner />;

  return (
    <div style={{ padding: '8px 0' }}>
      <h1 style={{
        fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700,
        letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16,
      }}>Dashboard</h1>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12, maxWidth: 900,
      }}>
        <KpiCard label="Active" value={kpis.active} />
        <KpiCard label="Live" value={kpis.live} accent="#FF6B00" />
        <KpiCard label="Closed" value={kpis.closed} />
        <KpiCard label="Ghosted" value={kpis.ghosted} accent="#ff7070" />
      </div>
    </div>
  );
}
