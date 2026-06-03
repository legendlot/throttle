'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Target } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

const ORANGE = '#FF6B00';
function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN'); }
function curMonth() { return new Date().toISOString().slice(0, 7); }
function monthLabel(m) {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// Progress bar: views fill greens as it approaches/exceeds target; spend goes
// amber/red as it approaches/exceeds budget. Cosmetic only.
function Bar({ pct, kind }) {
  if (pct == null) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  const w = Math.min(100, Math.max(0, pct));
  let color = ORANGE;
  if (kind === 'spend') color = pct > 100 ? '#ff7070' : pct > 85 ? '#fbbf24' : '#4ade80';
  else color = pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : ORANGE;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
        <div style={{ width: `${w}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color, minWidth: 38, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

export default function TargetsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.ignition_view;
  const canManage = !!perms?.ignition_manage;

  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const [month, setMonth] = useState(curMonth());
  const [targetViews, setTargetViews] = useState('');
  const [budget, setBudget] = useState('');
  const [note, setNote] = useState('');

  function load() {
    if (!session || !canView) return;
    ignitionopsGet('getMonthlyTargets', {}, session)
      .then(d => { setRows(d.months || []); setError(null); })
      .catch(e => setError(e.message));
  }
  useEffect(load, [session, canView]);

  function editRow(r) {
    setMonth(r.month);
    setTargetViews(r.target_views ?? '');
    setBudget(r.budget_amount ?? '');
    setNote(r.note || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save() {
    if (!/^\d{4}-\d{2}$/.test(month)) { toast('Pick a month', 'error'); return; }
    setSaving(true);
    try {
      await ignitionopsPost('upsertMonthlyTarget', {
        month, target_views: targetViews, budget_amount: budget, note,
      }, session);
      toast(`Saved target for ${monthLabel(month)}`, 'success');
      setTargetViews(''); setBudget(''); setNote('');
      load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  }

  if (!canView) return <EmptyState icon={Target} title="Access denied" message="You don't have the ignition_view permission." />;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Monthly Targets &amp; Budgets</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 4 }}>Set a views target and a budget for each month, then track actuals against them.</p>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {canManage && (
        <Panel title="Set / update a month">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Labeled label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} style={input} /></Labeled>
            <Labeled label="Target views"><input type="number" min="0" value={targetViews} onChange={e => setTargetViews(e.target.value)} placeholder="e.g. 5000000" style={input} /></Labeled>
            <Labeled label="Budget (₹)"><input type="number" min="0" value={budget} onChange={e => setBudget(e.target.value)} placeholder="e.g. 500000" style={input} /></Labeled>
            <Labeled label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} style={{ ...input, minWidth: 200 }} /></Labeled>
            <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Panel>
      )}

      <Panel title="Tracking">
        {rows == null ? <Spinner /> : rows.length === 0 ? (
          <EmptyState icon={Target} title="No targets yet" message={canManage ? 'Set one above to start tracking.' : 'No targets have been set.'} />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {['Month', 'Target views', 'Actual views', 'Views %', 'Budget', 'Spent', 'Spend %', 'Note'].map((h, i) => (
                  <th key={h} style={{ ...thr, textAlign: i === 0 || i === 7 ? 'left' : (i === 3 || i === 6 ? 'left' : 'right') }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.month} onClick={() => canManage && editRow(r)} style={{ borderTop: '1px solid var(--border)', cursor: canManage ? 'pointer' : 'default' }}>
                  <td style={{ ...tdl, fontWeight: 600, color: r.month === curMonth() ? ORANGE : 'var(--text-1)' }}>{monthLabel(r.month)}{r.month === curMonth() ? ' ·' : ''}</td>
                  <td style={tdr}>{num(r.target_views)}</td>
                  <td style={tdr}>{num(r.actual_views)}</td>
                  <td style={{ ...tdl, minWidth: 130 }}><Bar pct={r.views_pct} kind="views" /></td>
                  <td style={{ ...tdr, color: ORANGE }}>{inr(r.budget_amount)}</td>
                  <td style={tdr}>{inr(r.actual_spend)}</td>
                  <td style={{ ...tdl, minWidth: 130 }}><Bar pct={r.spend_pct} kind="spend" /></td>
                  <td style={tdl}>{r.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && rows && rows.length > 0 && <p style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 8 }}>Tip: click a row to edit that month above.</p>}
      </Panel>
    </div>
  );
}

function Labeled({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>{label}</span>
      {children}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-2)' }}>{title}</div>
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const btnPrimary = { padding: '8px 18px', background: ORANGE, color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thr = { padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700, fontFamily: 'var(--font-mono)' };
const tdl = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-2)' };
const tdr = { padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 12.5 };
