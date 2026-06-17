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
      <header style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        {viewing && <span style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warn-fg)' }}>Viewing snapshot</span>}
        <select value={viewing || ''} onChange={e => viewSnap(e.target.value || null)} style={sel}>
          <option value="">Live (current)</option>
          {snaps.map(s => <option key={s.id} value={s.id}>{s.label} · {fmtDate(s.captured_at)}</option>)}
        </select>
        {perms?.podium_hr && <button onClick={capture} disabled={busy} style={btn}><Camera size={14} /> {busy ? 'Saving…' : 'Capture snapshot'}</button>}
      </header>

      {nodes.length === 0
        ? <div style={{ color: 'var(--t3)' }}>No employees yet. Add people in the Directory to build the chart.</div>
        : <OrgChart nodes={nodes} onSelect={(n) => !viewing && router.push(`/people/detail/?id=${n.id}`)} />}

      {snaps.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <History size={13} /> {snaps.length} saved snapshot{snaps.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', borderRadius: 'var(--r-sm)', padding: '7px 13px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const sel = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontFamily: 'var(--font-num)', fontSize: 12.5, minWidth: 200 };
