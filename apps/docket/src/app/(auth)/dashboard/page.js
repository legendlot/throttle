'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { docketopsGet } from '../../../lib/docketopsFetch.js';
import { STATUS_MAP, STATUSES } from '../../../lib/tasks.js';

export default function DashboardPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try { setStats(await docketopsGet('getDashboard', {}, session)); }
    catch (e) { showToast(e.message || 'Failed to load dashboard', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !(perms.docket_view_all || perms.docket_admin))
    return <div style={{ color: 'var(--text-3)' }}>Requires org-wide visibility (docket_view_all).</div>;
  if (loading) return <Spinner />;
  if (!stats) return null;

  const byStatus = STATUSES.map(s => ({ name: s.label, key: s.key, value: Number(stats.by_status?.[s.key] || 0), color: s.color }));
  const openTotal = byStatus.filter(s => s.key !== 'done' && s.key !== 'abandoned').reduce((a, b) => a + b.value, 0);

  return (
    <div>
      <h1 style={h1}>Dashboard</h1>
      <p style={sub}>Org-wide task review.</p>

      <div style={tileRow}>
        <Tile label="Overdue" value={stats.overdue} accent="var(--state-error-fg)" onClick={() => router.push('/tasks?overdue=1')} />
        <Tile label="Due ≤ 7 days" value={stats.due_soon} accent="var(--state-warning-fg)" />
        <Tile label="Open" value={openTotal} />
        <Tile label="Done (30d)" value={stats.completed_30d} accent="var(--state-success-fg)" />
        <Tile label="Deadline revised" value={stats.revised} accent="var(--state-warning-fg)" onClick={() => router.push('/tasks?revised=1')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
        <section style={card}>
          <div style={sectionTitle}>Status distribution</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byStatus} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 11 }} axisLine={{ stroke: '#404040' }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: '#888', fontSize: 11 }} axisLine={{ stroke: '#404040' }} tickLine={false} />
                <Tooltip contentStyle={{ background: '#2a2a2a', border: '1px solid #404040', borderRadius: 4, fontSize: 12 }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {byStatus.map((s, i) => <Cell key={i} fill={s.color.startsWith('var') ? '#888' : s.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            {byStatus.map(s => (
              <span key={s.key} style={{ fontSize: 11, color: 'var(--text-3)' }}>
                <span style={{ color: s.color, fontWeight: 700 }}>{s.value}</span> {STATUS_MAP[s.key].label}
              </span>
            ))}
          </div>
        </section>

        <section style={card}>
          <div style={sectionTitle}>By team</div>
          <Table rows={stats.by_department || []} nameKey="dept_name"
            onRow={(r) => router.push(`/tasks?department_id=${r.dept_id}`)} />
        </section>
      </div>

      <section style={{ ...card, marginTop: 14 }}>
        <div style={sectionTitle}>By person (owner)</div>
        <Table rows={stats.by_person || []} nameKey="emp_name"
          onRow={(r) => router.push(`/tasks?employee_id=${r.emp_id}`)} showBlocked={false} />
      </section>
    </div>
  );
}

function Tile({ label, value, accent, onClick }) {
  return (
    <div style={{ ...tile, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <div style={{ fontFamily: 'var(--font-cond)', fontSize: 30, fontWeight: 700, color: accent || 'var(--text-1)', lineHeight: 1 }}>{Number(value || 0)}</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6 }}>{label}</div>
    </div>
  );
}

function Table({ rows, nameKey, onRow, showBlocked = true }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No tasks yet.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>{nameKey === 'dept_name' ? 'Team' : 'Person'}</th>
          <th style={thNum}>Open</th><th style={thNum}>Done</th>
          {showBlocked && <th style={thNum}>Blocked</th>}<th style={thNum}>Overdue</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onRow(r)}>
              <td style={td}>{r[nameKey] || '—'}</td>
              <td style={tdNum}>{Number(r.open || 0)}</td>
              <td style={tdNum}>{Number(r.done || 0)}</td>
              {showBlocked && <td style={tdNum}>{Number(r.blocked || 0)}</td>}
              <td style={{ ...tdNum, color: Number(r.overdue) > 0 ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: Number(r.overdue) > 0 ? 700 : 400 }}>{Number(r.overdue || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, marginBottom: 16 };
const tileRow = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 };
const tile = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px' };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px' };
const sectionTitle = { fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 12 };
const th = { textAlign: 'left', padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const thNum = { ...th, textAlign: 'right', width: 70 };
const td = { padding: '8px 10px', fontSize: 13, color: 'var(--text-1)', borderBottom: '1px solid var(--border)' };
const tdNum = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' };
