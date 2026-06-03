'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ClipboardCheck } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS, anchorOptions } from '../../../lib/appraisals.js';
import { fmtDate } from '../../../lib/format.js';

export default function AppraisalsPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [cycles, setCycles] = useState(null);
  const [creating, setCreating] = useState(false);
  const [anchor, setAnchor] = useState(anchorOptions()[2]?.value || '');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try { const r = await podiumopsGet('getAppraisalCycles', {}, session); setCycles(r.cycles || []); }
    catch (e) { showToast(e.message || 'Failed', 'error'); setCycles([]); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!anchor) { showToast('Pick an appraisal date', 'error'); return; }
    setSaving(true);
    try {
      const r = await podiumopsPost('createAppraisalCycle', { data: { appraisal_date: anchor, name: name.trim() || null } }, session);
      showToast('Cycle created', 'success');
      setCreating(false); setName('');
      router.push(`/appraisals/cycle/?id=${r.id}`);
    } catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--text-3)' }}>Requires podium_hr.</div>;
  if (!cycles) return <Spinner />;

  return (
    <div style={{ maxWidth: 860 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={h1}>Appraisals</h1>
          <p style={sub}>Twice-yearly cycles, anchored to Apr 1 / Oct 1. Create a cycle, enroll, then run reviews → calibration → share.</p>
        </div>
        {!creating
          ? <button style={btnPrimary} onClick={() => setCreating(true)}><Plus size={14} /> New cycle</button>
          : <button style={btnSecondary} onClick={() => setCreating(false)}>Cancel</button>}
      </header>

      {creating && (
        <div style={{ ...card, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <span style={lbl}>Appraisal date (anchor)</span>
              <select value={anchor} onChange={e => setAnchor(e.target.value)} style={input}>
                {anchorOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <span style={lbl}>Name (optional)</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. H2 2026" style={{ ...input, width: '100%' }} />
            </div>
            <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </div>
          <p style={{ ...sub, marginTop: 8 }}>The 6-month window + eligibility cutoff (anchor − 3 months) auto-derive. Increment effective date = the anchor.</p>
        </div>
      )}

      {cycles.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No cycles yet.</div> : (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>Cycle</th><th style={th}>Appraisal date</th><th style={th}>Window</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {cycles.map(c => (
                <tr key={c.id} onClick={() => router.push(`/appraisals/cycle/?id=${c.id}`)} style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={td}><ClipboardCheck size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--podium-accent)' }} />{c.name}</td>
                  <td style={td}>{fmtDate(c.appraisal_date)}</td>
                  <td style={{ ...td, color: 'var(--text-3)', fontSize: 12 }}>{fmtDate(c.period_start)} → {fmtDate(c.period_end)}</td>
                  <td style={td}><span style={badge(c.status)}>{CYCLE_STATUS[c.status] || c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, maxWidth: 620, lineHeight: 1.5 };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' };
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 700 };
const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, outline: 'none' };
const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 };
const td = { padding: '9px 12px' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnPrimary = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
function badge(status) {
  const map = { draft: 'var(--text-3)', active: 'var(--state-success-fg)', calibration: 'var(--state-warning-fg)', closed: 'var(--text-3)' };
  return { fontFamily: 'var(--font-mono)', fontSize: 10, color: map[status] || 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 7px', textTransform: 'uppercase' };
}
