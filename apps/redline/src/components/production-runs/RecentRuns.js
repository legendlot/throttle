'use client';
import { useCallback, useEffect, useState } from 'react';
import { garageFetch, workerFetch } from '@throttle/db';
import { Panel, Spinner, useToast } from '@throttle/ui';
import { RunDetailPanel } from './RunDetailPanel.js';

// Production-facing run management, folded onto the New Run / Request tab (run-request
// consolidation, 2026-06-08). Production requests above; here it tracks and acts on its runs:
//   Requested  → pre-issue (Cancel)
//   Issued     → in-house active (Confirm Receipt / Re-Appeal / Complete)
//   Upcoming   → outsourced sent to vendor, awaiting return (Request Finish / Complete)
// Store-side fulfilment (issue, reject, send-to-vendor, receive, issue-finish) stays in the
// Garage Issue Queue. Repair runs are managed in the Redline repair surfaces, not here.

const th = { padding: '7px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--t3)', textAlign: 'left', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', borderBottom: '1px solid rgba(64,64,64,.4)', fontSize: 12, whiteSpace: 'nowrap' };
const btnS = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', cursor: 'pointer' };
const groupHdr = { fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '14px 0 6px' };

const STATUS_TONE = {
  Draft: 'var(--t3)', Submitted: 'var(--state-info-fg, #7b93ff)', Picking: '#fbbf24',
  Issued: 'var(--yellow)', 'In Progress': 'var(--yellow)',
  Completed: 'var(--state-success-fg, #4ade80)', Rejected: 'var(--state-error-fg, #ff7070)', Cancelled: 'var(--t3)',
};

function variantSummary(run) {
  const vs = (run.variants || []).map(v => {
    const name = v.variant || 'Common';
    const c = v.colour ? ` ${v.colour}` : '';
    return `${name}${c} ×${v.qty}`;
  });
  return vs.join(', ') || '—';
}

function RunTable({ rows, onOpen, emptyText, showVendor }) {
  if (!rows.length) return <div style={{ padding: '8px 10px', color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>{emptyText}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Run</th><th style={th}>Product</th>
          {showVendor && <th style={th}>Vendor</th>}
          <th style={th}>Variants</th><th style={th}>Units</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}></th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.run_no} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.run_no)}>
              <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.run_no}</td>
              <td style={td}>{r.product || '—'}</td>
              {showVendor && <td style={{ ...td, color: 'var(--t2)' }}>{r.vendor?.vendor_name || '—'}</td>}
              <td style={{ ...td, color: 'var(--t2)' }}>{variantSummary(r)}</td>
              <td style={{ ...td, fontFamily: 'var(--mono)' }}>{r.total_units || 0}</td>
              <td style={{ ...td, fontFamily: 'var(--mono)', color: STATUS_TONE[r.status] || 'var(--t2)' }}>{r.status}</td>
              <td style={{ ...td, textAlign: 'right' }}><button style={btnS} onClick={(e) => { e.stopPropagation(); onOpen(r.run_no); }}>Open →</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecentRuns({ session, perms }) {
  const { showToast } = useToast();
  const [runs, setRuns] = useState([]);
  const [wos, setWos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openRunNo, setOpenRunNo] = useState(null);
  const [cancellingWo, setCancellingWo] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const d = new Date(); d.setDate(d.getDate() - 7);
      const since = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
      const [sub, pick, iss, prog, done, workorders] = await Promise.all([
        garageFetch('getProductionRuns', { status: 'Submitted' }, session),
        garageFetch('getProductionRuns', { status: 'Picking' }, session),
        garageFetch('getProductionRuns', { status: 'Issued' }, session),
        garageFetch('getProductionRuns', { status: 'In Progress' }, session),
        garageFetch('getProductionRuns', { status: 'Completed', date_from: since }, session),
        garageFetch('getWorkOrders', {}, session),
      ]);
      const all = [sub, pick, iss, prog, done].flatMap(x => (Array.isArray(x) ? x : []));
      const seen = new Set(); const merged = [];
      all.forEach(r => { if (r && !seen.has(r.run_no)) { seen.add(r.run_no); merged.push(r); } });
      setRuns(merged);
      setWos(Array.isArray(workorders) ? workorders : []);
    } catch (e) {
      showToast(e.message || 'Failed to load runs', 'error');
    } finally { setLoading(false); }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const requested = runs.filter(r => ['Draft', 'Submitted', 'Picking'].includes(r.status));
  const issued    = runs.filter(r => r.run_type !== 'outsourced' && ['Issued', 'In Progress'].includes(r.status));
  const upcoming  = runs.filter(r => r.run_type === 'outsourced' && ['Issued', 'In Progress'].includes(r.status));
  const recent    = runs.filter(r => r.status === 'Completed');
  const adhoc     = wos.filter(w => ['Parts Request', 'adhoc', 'standalone'].includes(w.wo_type)
                    && !['Cancelled', 'Closed', 'Completed', 'Issued'].includes(w.status));

  function onRunChange() { setOpenRunNo(null); load(); }

  async function cancelWo(wo) {
    if (!window.confirm(`Cancel ad-hoc request ${wo.wo_no}?`)) return;
    setCancellingWo(wo.wo_no);
    try {
      await workerFetch('updateWorkOrder', { data: { wo_no: wo.wo_no, status: 'Cancelled' } }, session);
      showToast(`${wo.wo_no} cancelled`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    } finally { setCancellingWo(null); }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <Panel
        header="Recent Runs"
        headerAction={<button style={btnS} onClick={load} disabled={loading}>{loading ? '…' : '↻ Refresh'}</button>}
      >
        {loading && runs.length === 0 ? <Spinner /> : (
          <>
            <div style={groupHdr}>Requested · {requested.length} <span style={{ color: 'var(--t3)', fontWeight: 400, textTransform: 'none' }}>— pre-issue, you can cancel</span></div>
            <RunTable rows={requested} onOpen={setOpenRunNo} emptyText="No runs awaiting the store." />

            <div style={groupHdr}>Issued · {issued.length} <span style={{ color: 'var(--t3)', fontWeight: 400, textTransform: 'none' }}>— confirm receipt &amp; complete</span></div>
            <RunTable rows={issued} onOpen={setOpenRunNo} emptyText="No in-house runs in progress." />

            <div style={groupHdr}>Upcoming · {upcoming.length} <span style={{ color: 'var(--t3)', fontWeight: 400, textTransform: 'none' }}>— outsourced, at the vendor; request finish when units return</span></div>
            <RunTable rows={upcoming} onOpen={setOpenRunNo} emptyText="No outsourced runs out at a vendor." showVendor />

            {adhoc.length > 0 && (
              <>
                <div style={groupHdr}>Ad-Hoc Parts Requests · {adhoc.length}</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={th}>WO</th><th style={th}>Product</th><th style={th}>Line</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}></th></tr></thead>
                    <tbody>
                      {adhoc.map(w => (
                        <tr key={w.wo_no}>
                          <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{w.wo_no}</td>
                          <td style={td}>{w.product || '—'}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)' }}>{w.line_no || '—'}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{w.status || '—'}</td>
                          <td style={{ ...td, textAlign: 'right' }}>
                            <button style={btnS} disabled={cancellingWo === w.wo_no} onClick={() => cancelWo(w)}>
                              {cancellingWo === w.wo_no ? '…' : 'Cancel'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {recent.length > 0 && (
              <>
                <div style={groupHdr}>Recently Completed · {recent.length}</div>
                <RunTable rows={recent} onOpen={setOpenRunNo} emptyText="—" showVendor />
              </>
            )}
          </>
        )}
      </Panel>

      {openRunNo && (
        <RunDetailPanel
          runNo={openRunNo}
          session={session}
          perms={perms}
          onClose={() => setOpenRunNo(null)}
          onRunChange={onRunChange}
        />
      )}
    </div>
  );
}
