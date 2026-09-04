'use client';
// ════════════════════════════════════════════════════════════════════
// Device Register — step ④ of the scanner device-identity work.
//
// Lists the handsets seen via the LOT Scanner APK (window.LOTDevice -> X-LOT-HW ->
// public.device_hw), and lets an admin label and classify them without SQL. That labelling is
// the point: during rollout someone is standing next to a phone and knows which one it is, and
// that knowledge is unrecoverable an hour later.
//
// ⛔ OBSERVE ONLY. Nothing here blocks anything. 'blocked' is storable and read by nothing.
// ⚠️ AN ABSENT DEVICE MEANS "NOT RUNNING THE APK", NOT "NOT SCANNING" — a browser sends no
// X-LOT-HW at all, so until rollout is complete this list is NOT an inventory of active
// devices and "unknown" is overwhelmingly "no APK yet" rather than an intruder. The banner
// below says so on-screen, deliberately, so nobody reads a red count as a security event.
// ⚠️ claimed_device_code is CLIENT-SUPPLIED and proves nothing on its own; hw_id is an
// identifier, not a credential (it is readable from the page inside the app).
// ════════════════════════════════════════════════════════════════════
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Smartphone, RefreshCw, Search } from 'lucide-react';

const STATUSES = ['unknown', 'known', 'blocked'];

const STATUS_STYLE = {
  known:   { bg: 'rgba(34,197,94,.12)',  fg: '#22c55e', label: 'Known' },
  unknown: { bg: 'rgba(242,205,26,.12)', fg: '#F2CD1A', label: 'Unknown' },
  blocked: { bg: 'rgba(222,42,42,.12)',  fg: '#DE2A2A', label: 'Blocked' },
};

function ago(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function istStamp(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return ts; }
}

export default function DevicesPage() {
  // ⚠️ Key loads on userId, NEVER on the session object: onAuthStateChange re-fires on tab
  // switch and a real token refresh lands ~hourly, and this page holds unsaved label edits.
  // ⚠️ And do NOT close over `session` either — workerFetch does not self-heal a stale token,
  // so the token is read inside each callback via getValidSession().
  const { userId } = useAuth();
  const toast = useToast();

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [firstDone, setFirstDone] = useState(false);
  const [q, setQ]             = useState('');
  const [savingId, setSaving] = useState(null);
  const [drafts, setDrafts]   = useState({});   // hw_id -> label being typed

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getValidSession();
      const r = await workerFetch('getDeviceHw', {}, s);
      if (r?.ok) setRows(r.data?.devices || []);
      else toast?.error?.(r?.error || 'Could not load devices');
    } catch (e) {
      toast?.error?.('Could not load devices: ' + e.message);
    } finally {
      setLoading(false);
      setFirstDone(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => { if (userId) load(); }, [userId, load]);

  const save = async (hw_id, patch) => {
    setSaving(hw_id);
    try {
      const s = await getValidSession();
      // ⚠️ workerFetch flattens its body as {action, ...body}, and the worker handler reads
      // body.data — so the payload MUST be wrapped, exactly as the users page does. Passing it
      // flat yields "hw_id required" from a call that looks perfectly correct at this end.
      const r = await workerFetch('setDeviceHw', { data: { hw_id, ...patch } }, s);
      if (!r?.ok) { toast?.error?.(r?.error || 'Update failed'); return; }
      setRows(rs => rs.map(x => (x.hw_id === hw_id ? { ...x, ...patch } : x)));
      setDrafts(d => { const n = { ...d }; delete n[hw_id]; return n; });
      toast?.success?.('Saved');
    } catch (e) {
      toast?.error?.('Update failed: ' + e.message);
    } finally { setSaving(null); }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => [r.hw_id, r.label, r.claimed_device_code, r.last_station, r.last_ip]
      .some(v => String(v || '').toLowerCase().includes(needle)));
  }, [rows, q]);

  const counts = useMemo(() => rows.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1; return a;
  }, {}), [rows]);

  // ⚠️ A spinner must never replace a surface holding unsaved input — this page has label
  // drafts, so only the FIRST load is allowed to take over the screen.
  if (loading && !firstDone) return <Spinner />;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <Smartphone size={22} />
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Device Register</h1>
        <button onClick={load} disabled={loading}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
                   padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                   border: '1px solid var(--border,#404040)', background: 'transparent',
                   color: 'inherit', opacity: loading ? .6 : 1 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* ⚠️ This caveat is load-bearing, not decoration. Without it an "unknown" count reads as
          intruders when it is really just phones that have not had the app installed yet. */}
      <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 18,
                    border: '1px solid rgba(242,205,26,.35)', background: 'rgba(242,205,26,.07)',
                    fontSize: 13, lineHeight: 1.5 }}>
        <strong>Only phones running the LOT Scanner app appear here.</strong> A handset using the
        website sends no device ID at all, so it is simply absent — an <em>Unknown</em> device
        almost always means “the app is not installed yet”, not “an unrecognised phone”. Treat
        this as a rollout checklist until every scanner has the app.
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {STATUSES.map(s => (
          <div key={s} style={{ padding: '5px 11px', borderRadius: 999, fontSize: 12,
                                fontWeight: 700, background: STATUS_STYLE[s].bg,
                                color: STATUS_STYLE[s].fg }}>
            {STATUS_STYLE[s].label}: {counts[s] || 0}
          </div>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
                      border: '1px solid var(--border,#404040)', borderRadius: 8,
                      padding: '5px 10px' }}>
          <Search size={14} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search id, label, station, IP"
            style={{ border: 'none', outline: 'none', background: 'transparent',
                     color: 'inherit', fontSize: 13, width: 210 }} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', opacity: .7, fontSize: 14 }}>
          {rows.length === 0
            ? 'No devices seen yet. A phone appears here the first time it uses the LOT Scanner app.'
            : 'No devices match that search.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border,#404040)' }}>
                {['Device', 'Label', 'Status', 'Last seen', 'Last action', 'Says it is', 'IP', 'Seen'].map(h => (
                  <th key={h} style={{ padding: '9px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const draft = drafts[r.hw_id];
                const dirty = draft !== undefined && draft !== (r.label || '');
                return (
                  <tr key={r.hw_id} style={{ borderBottom: '1px solid var(--border,#333)' }}>
                    <td style={{ padding: '9px 10px', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                      {r.hw_id}
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          value={draft !== undefined ? draft : (r.label || '')}
                          onChange={e => setDrafts(d => ({ ...d, [r.hw_id]: e.target.value }))}
                          placeholder="e.g. INW line 1 scanner"
                          style={{ flex: 1, minWidth: 170, padding: '5px 8px', borderRadius: 6,
                                   border: '1px solid var(--border,#404040)',
                                   background: 'transparent', color: 'inherit', fontSize: 13 }} />
                        {dirty && (
                          <button onClick={() => save(r.hw_id, { label: draft })}
                            disabled={savingId === r.hw_id}
                            style={{ padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                                     border: 'none', background: '#F2CD1A', color: '#1f1f1f',
                                     fontWeight: 700, fontSize: 12 }}>
                            {savingId === r.hw_id ? '…' : 'Save'}
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      <select value={r.status}
                        onChange={e => save(r.hw_id, { status: e.target.value })}
                        disabled={savingId === r.hw_id}
                        style={{ padding: '5px 8px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                                 border: '1px solid var(--border,#404040)',
                                 background: STATUS_STYLE[r.status]?.bg || 'transparent',
                                 color: STATUS_STYLE[r.status]?.fg || 'inherit' }}>
                        {STATUSES.map(s => <option key={s} value={s}>{STATUS_STYLE[s].label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}
                        title={istStamp(r.last_seen)}>{ago(r.last_seen)}</td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>{r.last_action || '—'}</td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}
                        title="Client-supplied — proves nothing on its own">
                      {r.claimed_device_code || '—'}
                    </td>
                    <td style={{ padding: '9px 10px', fontFamily: 'ui-monospace, monospace',
                                 whiteSpace: 'nowrap', opacity: .8 }}>{r.last_ip || '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{r.sightings ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
