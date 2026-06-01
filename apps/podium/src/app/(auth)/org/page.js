'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Camera, History } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import OrgChart from '../../../components/OrgChart.js';
import { fmtDate } from '../../../lib/format.js';

export default function OrgPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [nodes, setNodes] = useState(null);
  const [snaps, setSnaps] = useState([]);
  const [viewing, setViewing] = useState(null);   // snapshot id being viewed, or null = live
  const [busy, setBusy] = useState(false);

  const loadLive = useCallback(() => {
    podiumopsGet('getOrgChart', {}, session).then(r => setNodes(r.nodes || [])).catch(() => setNodes([]));
  }, [session]);
  const loadSnaps = useCallback(() => {
    podiumopsGet('getOrgSnapshots', {}, session).then(r => setSnaps(r.snapshots || [])).catch(() => {});
  }, [session]);

  useEffect(() => { if (session) { loadLive(); loadSnaps(); } }, [session, loadLive, loadSnaps]);

  async function viewSnap(id) {
    if (!id) { setViewing(null); loadLive(); return; }
    const r = await podiumopsGet('getOrgSnapshots', { id }, session);
    setNodes(r.snapshot?.snapshot?.nodes || []);
    setViewing(id);
  }
  async function capture() {
    setBusy(true);
    try {
      const label = prompt('Snapshot label?', `Snapshot ${new Date().toISOString().slice(0, 10)}`);
      if (label === null) { setBusy(false); return; }
      await podiumopsPost('captureOrgSnapshot', { label }, session);
      showToast('Snapshot captured', 'success');
      loadSnaps();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!nodes) return <Spinner />;

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Org Chart {viewing && <span style={{ fontSize: 12, color: 'var(--state-warning-fg)' }}>· snapshot</span>}
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={viewing || ''} onChange={e => viewSnap(e.target.value || null)} style={sel}>
            <option value="">Live (current)</option>
            {snaps.map(s => <option key={s.id} value={s.id}>{s.label} · {fmtDate(s.captured_at)}</option>)}
          </select>
          {perms?.podium_hr && <button onClick={capture} disabled={busy} style={btn}><Camera size={14} /> {busy ? 'Saving…' : 'Capture snapshot'}</button>}
        </div>
      </header>

      {nodes.length === 0
        ? <div style={{ color: 'var(--text-3)' }}>No employees yet. Add people in the Directory to build the chart.</div>
        : <OrgChart nodes={nodes} onSelect={(n) => !viewing && router.push(`/people/detail/?id=${n.id}`)} />}

      {snaps.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <History size={13} /> {snaps.length} saved snapshot{snaps.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-green)', color: '#04130d', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontWeight: 700, fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const sel = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 200 };
