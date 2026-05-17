'use client';
import { useState } from 'react';
import { useAuth } from '@throttle/auth';

// Manpower page is now a stub. Operators / Attendance / Daily Roster /
// Performance moved to Redline /manpower. The Store Activities tab will be
// filled in by CC_TASK_STORE_ACTIVITIES.md.
export default function ManpowerPage() {
  const { perms } = useAuth();
  const [activeTab, setActiveTab] = useState('store');

  // canManageFloor mirrors worker.js's canManageFloor predicate.
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  if (perms && !perms.dashboard) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Manpower
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Store-side activity log. Operator, attendance, roster, and performance are now on Redline.
        </p>
      </div>

      <TabBar
        tabs={[{ key: 'store', label: 'Store Activities' }]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {!canManageFloor ? (
        <div style={{ color: 'var(--t3)', padding: '40px 0', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12 }}>
          Store activities are restricted to floor supervisors.
        </div>
      ) : (
        <div style={{ color: 'var(--t2)', padding: '40px 0', textAlign: 'center' }}>
          Store activity management coming soon.
        </div>
      )}
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: on ? '2px solid var(--yellow)' : '2px solid transparent',
              padding: '8px 14px',
              fontFamily: 'var(--cond)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: on ? 'var(--yellow)' : 'var(--t2)',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
