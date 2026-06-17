'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ClipboardCheck } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS, anchorOptions } from '../../../lib/appraisals.js';
import { fmtDate } from '../../../lib/format.js';
import { GridHead, GridRow, gridTh, PrimaryButton, btnGhost, formLabel } from '../../../components/ui.js';

const COLS = '1.2fr 1fr 1.8fr 110px';

// status → semantic dot-pill (active=ok, calibration=warn, closed=neutral, draft=neutral)
const STATUS_PILL = {
  active:      { fg: 'var(--ok-fg)',      bg: 'var(--ok-bg)',      bd: 'var(--ok-bd)' },
  calibration: { fg: 'var(--warn-fg)',    bg: 'var(--warn-bg)',    bd: 'var(--warn-bd)' },
  closed:      { fg: 'var(--neutral-fg)', bg: 'var(--neutral-bg)', bd: 'var(--neutral-bd)' },
  draft:       { fg: 'var(--neutral-fg)', bg: 'var(--neutral-bg)', bd: 'var(--neutral-bd)' },
};

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

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (!cycles) return <Spinner />;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13.5, color: 'var(--t3)', lineHeight: 1.5, maxWidth: 560, margin: 0 }}>
          Twice-yearly cycles anchored to Apr 1 and Oct 1. Create a cycle, enroll people, then run reviews into calibration and share.
        </p>
        <span style={{ flex: 1 }} />
        {!creating
          ? <PrimaryButton onClick={() => setCreating(true)}>New Cycle</PrimaryButton>
          : <button style={btnGhost} onClick={() => setCreating(false)}>Cancel</button>}
      </div>

      {creating && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={formLabel}>Appraisal date (anchor)</div>
              <select value={anchor} onChange={e => setAnchor(e.target.value)} style={input}>
                {anchorOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={formLabel}>Name (optional)</div>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. H2 2026" className="pd-input" style={{ ...input, width: '100%' }} />
            </div>
            <button style={{ ...primaryInline, opacity: saving ? 0.6 : 1 }} onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 10 }}>The 6-month window + eligibility cutoff (anchor − 3 months) auto-derive. Increment effective date = the anchor.</p>
        </div>
      )}

      {cycles.length === 0 ? <div style={{ color: 'var(--t3)' }}>No cycles yet.</div> : (
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>Cycle</div>
            <div style={gridTh}>Appraisal date</div>
            <div style={gridTh}>Window</div>
            <div style={gridTh}>Status</div>
          </GridHead>
          {cycles.map(c => {
            const p = STATUS_PILL[c.status] || STATUS_PILL.draft;
            return (
              <GridRow key={c.id} cols={COLS} onClick={() => router.push(`/appraisals/cycle/?id=${c.id}`)}>
                <div style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ClipboardCheck size={14} color="var(--yellow)" />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{c.name}</span>
                </div>
                <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 12.5, color: 'var(--t2)' }}>{fmtDate(c.appraisal_date)}</span></div>
                <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{fmtDate(c.period_start)} → {fmtDate(c.period_end)}</span></div>
                <div style={{ padding: '11px 16px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 5, color: p.fg, background: p.bg, border: `1px solid ${p.bd}` }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.fg }} />{CYCLE_STATUS[c.status] || c.status}
                  </span>
                </div>
              </GridRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

const input = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '9px 11px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-ui)' };
const primaryInline = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', borderRadius: 'var(--r-sm)', padding: '9px 16px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
