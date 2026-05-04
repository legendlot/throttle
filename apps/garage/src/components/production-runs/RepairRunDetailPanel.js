'use client';
import { useEffect, useState } from 'react';
import { ConfirmModal, EmptyState, Spinner, useToast } from '@throttle/ui';
import { garageFetch, workerFetch } from '@throttle/db';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  gap: 12, flexWrap: 'wrap',
};
const th = {
  padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const btnPri = {
  background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4,
  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer',
};

const REPAIR_STATUS_COLOR = {
  planned: 'var(--t3)',
  active: 'var(--yellow)',
  completed: 'var(--green)',
  cancelled: 'var(--t3)',
};

const UNIT_STATUS_COLOR = {
  in_repair: 'var(--yellow)',
  repaired: 'var(--green)',
  scrapped_repair: 'var(--red)',
  queued: 'var(--t3)',
};

function formatIST(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  let hour = d.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${String(hour).padStart(2, '0')}:${min} ${ampm}`;
}

function StatBox({ label, value, color }) {
  return (
    <div
      style={{
        background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4,
        padding: '8px 14px', minWidth: 110,
      }}
    >
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 3 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: color || 'var(--t1)' }}>
        {value}
      </div>
    </div>
  );
}

export function RepairRunDetailPanel({ runId, runNo, onClose, onRunChange, session }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [actionSubmitting, setActionSubmitting] = useState(false);

  async function load() {
    if (!runId || !session) return;
    setLoading(true);
    setError(null);
    try {
      const res = await garageFetch('getRepairRunDetail', { run_id: runId }, session);
      setData(res);
    } catch (e) {
      setError(e.message || 'Failed to load repair run');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [runId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeStatus(status, successMsg) {
    setActionSubmitting(true);
    try {
      await workerFetch('updateRepairRunStatus', { data: { run_id: runId, status } }, session);
      showToast(successMsg, 'success');
      setCompleteOpen(false);
      setCancelOpen(false);
      onRunChange();
      if (status === 'completed' || status === 'cancelled') onClose();
    } catch (e) {
      showToast(e.message || 'Status update failed', 'error');
    } finally {
      setActionSubmitting(false);
    }
  }

  if (loading && !data) {
    return (
      <div id="pr-detail-panel" style={{ ...panel, marginTop: 16, padding: 32, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div id="pr-detail-panel" style={{ ...panel, marginTop: 16 }}>
        <div style={{ padding: 16 }}>
          <EmptyState message={error} />
          <div style={{ textAlign: 'center', marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button style={btnSec} onClick={load}>Retry</button>
            <button style={btnSec} onClick={onClose}>✕ Close</button>
          </div>
        </div>
      </div>
    );
  }
  if (!data?.run) return null;

  const run = data.run;
  const units = data.units || [];
  const lines = data.lines || [];
  const counts = run._counts || { total: 0, in_repair: 0, repaired: 0, scrapped: 0 };
  const status = (run.status || '').toLowerCase();

  const showComplete = status === 'active';
  const showCancel = ['planned', 'active'].includes(status);

  return (
    <div id="pr-detail-panel" style={{ ...panel, marginTop: 16 }}>
      <div style={panelHdr}>
        <span>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{run.run_no}</span>
          <span style={{ color: 'var(--t3)', margin: '0 8px' }}>—</span>
          <span>{run.line || '—'}</span>
          <span style={{ color: 'var(--t3)', margin: '0 8px' }}>—</span>
          <span style={{ color: REPAIR_STATUS_COLOR[status] || 'var(--t2)', fontWeight: 700 }}>
            {(run.status || '').toUpperCase()}
          </span>
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {showComplete && (
            <button style={btnPri} onClick={() => setCompleteOpen(true)}>Mark Complete</button>
          )}
          {showCancel && (
            <button style={btnSec} onClick={() => setCancelOpen(true)}>Cancel</button>
          )}
          <button style={btnSec} onClick={onClose}>✕ Close</button>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {/* Stats row */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatBox label="Status" value={(run.status || '—').toUpperCase()} color={REPAIR_STATUS_COLOR[status]} />
          <StatBox label="Total" value={counts.total ?? 0} />
          <StatBox label="In Repair" value={counts.in_repair ?? 0} color="var(--yellow)" />
          <StatBox label="Repaired" value={counts.repaired ?? 0} color="var(--green)" />
          <StatBox label="Scrapped" value={counts.scrapped ?? 0} color="var(--red)" />
          {run.notes && (
            <div
              style={{
                padding: '8px 14px', borderRadius: 4,
                background: 'rgba(80,80,80,.15)', border: '1px solid var(--border)',
                fontSize: 11, color: 'var(--t2)', alignSelf: 'center',
              }}
            >
              {run.notes}
            </div>
          )}
        </div>

        {/* Planned units table */}
        {lines.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Planned Units
            </div>
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Product</th>
                    <th style={th}>Model</th>
                    <th style={th}>Color</th>
                    <th style={{ ...th, textAlign: 'right' }}>Cars</th>
                    <th style={{ ...th, textAlign: 'right' }}>Remotes</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td style={td}>{l.product || '—'}</td>
                      <td style={td}>{l.model || '—'}</td>
                      <td style={td}>{l.color || '—'}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{l.target_car_qty ?? 0}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{l.target_remote_qty ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Units in this run */}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Units in this Run
        </div>
        {units.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '8px 0' }}>
            No units scanned yet — operators scan at the Repair station
          </div>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>UPC</th>
                  <th style={th}>Product</th>
                  <th style={th}>Model</th>
                  <th style={th}>Color</th>
                  <th style={th}>Status</th>
                  <th style={th}>Started</th>
                  <th style={th}>Completed</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u, i) => {
                  const ust = (u.status || '').toLowerCase();
                  return (
                    <tr key={i}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 11 }}>{u.upc || '—'}</td>
                      <td style={td}>{u.product || '—'}</td>
                      <td style={td}>{u.model || '—'}</td>
                      <td style={td}>{u.color || '—'}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: UNIT_STATUS_COLOR[ust] || 'var(--t2)' }}>
                        {(u.status || '').toUpperCase()}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{formatIST(u.started_at)}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{formatIST(u.completed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={completeOpen}
        onClose={() => !actionSubmitting && setCompleteOpen(false)}
        title={`Complete ${run.run_no}`}
        message={`Mark repair run ${run.run_no} as completed?`}
        confirmLabel={actionSubmitting ? 'UPDATING…' : 'Mark Complete'}
        onConfirm={() => changeStatus('completed', 'Repair run completed')}
        loading={actionSubmitting}
      />
      <ConfirmModal
        open={cancelOpen}
        onClose={() => !actionSubmitting && setCancelOpen(false)}
        title={`Cancel ${run.run_no}`}
        message={`Cancel repair run ${run.run_no}?`}
        confirmLabel={actionSubmitting ? 'UPDATING…' : 'Cancel Run'}
        confirmColor="red"
        onConfirm={() => changeStatus('cancelled', 'Repair run cancelled')}
        loading={actionSubmitting}
      />
    </div>
  );
}
