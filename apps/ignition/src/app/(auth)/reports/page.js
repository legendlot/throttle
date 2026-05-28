'use client';
import { useAuth } from '@throttle/auth';

export default function ReportsPage() {
  const { perms } = useAuth();
  if (!perms?.ignition_reports_view) return <div style={{ padding: 16, color: 'var(--text-3)' }}>You don't have permission to view reports.</div>;
  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>
        Reports
      </h1>
      <div style={{
        padding: 32, background: 'var(--surface)', border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)', textAlign: 'center', color: 'var(--text-3)',
      }}>
        <div style={{ fontSize: 13, marginBottom: 8 }}>Reports build lands in Phase B.</div>
        <div style={{ fontSize: 11 }}>Spend × month / ROAS × product / CPM distribution / top performers</div>
      </div>
    </div>
  );
}
