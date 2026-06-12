'use client';
/* ════════════════════════════════════════════════════════════
   OPERATORS — Setup › Operators (Pit Wall v2 reskin of
   redesign-reference/app/operators.jsx). Backend operator
   directory that feeds Attendance + Manpower. Search · dept +
   status filters · Add Operator (auto-assigns LOT-FACT-#### +
   QR badge) · per-row QR / Edit / Deactivate. All data actions
   (getOperators, createOperator, updateOperator, QR print HTML)
   kept exactly as before — visual layer only.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, useToast, printWindow, useEscapeClose } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

// ── Constants ────────────────────────────────────────────────
// Department values must match the CHECK constraint on public.operators.
const DEPARTMENTS = [
  { value: 'assembly',  label: 'Assembly'  },
  { value: 'qc',        label: 'QC'        },
  { value: 'packaging', label: 'Packaging' },
  { value: 'admin',     label: 'Admin'     },
  { value: 'store',     label: 'Store'     },
  { value: 'dispatch',  label: 'Dispatch'  },
];
const DEPT_LABEL = Object.fromEntries(DEPARTMENTS.map(d => [d.value, d.label]));

const EMPLOYMENT_TYPES = [
  { value: 'in_house', label: 'In House' },
  { value: 'contract', label: 'Contract' },
];

const STATUSES = [
  { value: 'active',   label: 'Active'   },
  { value: 'inactive', label: 'Inactive' },
];

// ── Styles ───────────────────────────────────────────────────
const selectStyle = {
  background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  padding: '9px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13,
  outline: 'none', cursor: 'pointer',
};
const modalInput = {
  background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  padding: '9px 11px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14,
  outline: 'none', width: '100%',
};
const actionBtn = (color) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
  border: `1px solid ${color}`, color, borderRadius: 'var(--r-xs)', padding: '4px 9px',
  fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
});

const COLS = 'minmax(160px,1.5fr) 150px 130px 110px 110px 220px';

// ── Operators Page ───────────────────────────────────────────
export default function OperatorsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  // Permission: anyone with the floor-management role (or admin) can manage
  // operators. The worker itself gates by canManageFloor — this guards the UI.
  const canEdit = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  const [operators, setOperators]     = useState([]);
  const [loading,   setLoading]       = useState(false);

  const [search,       setSearch]     = useState('');
  const [deptFilter,   setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');

  // Modal state
  const [modal,   setModal]   = useState(null); // { mode: 'add' | 'edit', op? }
  const [mName,   setMName]   = useState('');
  const [mDept,   setMDept]   = useState('assembly');
  const [mType,   setMType]   = useState('in_house');
  const [mStatus, setMStatus] = useState('active');
  const [mPhone,  setMPhone]  = useState('');
  const [mError,  setMError]  = useState('');
  const [mSaving, setMSaving] = useState(false);

  useEscapeClose(!!modal && !mSaving, () => setModal(null));

  // ── Load operators ────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setRefreshing(true);
    try {
      const res = await workerFetch('getOperators', { data: {} }, session);
      const rows = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
      setOperators(rows);
    } catch (e) {
      showToast(e?.message || 'Failed to load operators', 'error');
      setOperators([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, showToast, setRefreshing, setLastRefreshed]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtered rows ─────────────────────────────────────────
  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return operators
      .filter(o => statusFilter ? (o.status || '').toLowerCase() === statusFilter : true)
      .filter(o => deptFilter   ? o.department === deptFilter : true)
      .filter(o => !q ? true : (
        (o.name || '').toLowerCase().includes(q) ||
        (o.employee_id || '').toLowerCase().includes(q) ||
        (o.legacy_employee_id || '').toLowerCase().includes(q)
      ));
  }, [operators, search, deptFilter, statusFilter]);

  // ── Add / Edit modal ──────────────────────────────────────
  function openAdd() {
    setModal({ mode: 'add', op: null });
    setMName(''); setMDept('assembly'); setMType('in_house');
    setMStatus('active'); setMPhone(''); setMError('');
  }
  function openEdit(op) {
    setModal({ mode: 'edit', op });
    setMName(op.name || '');
    setMDept(op.department || 'assembly');
    setMType(op.employment_type || 'in_house');
    setMStatus(op.status || 'active');
    setMPhone(op.phone || '');
    setMError('');
  }

  async function submitModal() {
    if (!mName.trim()) { setMError('Name is required'); return; }
    setMSaving(true); setMError('');
    try {
      if (modal.mode === 'add') {
        await workerFetch('createOperator', {
          data: {
            name:            mName.trim(),
            department:      mDept,
            employment_type: mType,
            phone:           mPhone.trim() || null,
          },
        }, session);
        showToast('Operator added', 'success');
      } else {
        await workerFetch('updateOperator', {
          data: {
            operator_id:     modal.op.id,
            name:            mName.trim(),
            department:      mDept,
            employment_type: mType,
            status:          mStatus,
            phone:           mPhone.trim() || null,
          },
        }, session);
        showToast('Operator updated', 'success');
      }
      setModal(null);
      await loadData();
    } catch (e) {
      setMError(e?.message || 'Save failed');
    } finally {
      setMSaving(false);
    }
  }

  async function deactivate(op) {
    if (!confirm(`Deactivate ${op.name}?`)) return;
    try {
      await workerFetch('updateOperator', {
        data: { operator_id: op.id, status: 'inactive' },
      }, session);
      showToast('Operator deactivated', 'success');
      await loadData();
    } catch (e) {
      showToast(e?.message || 'Failed to deactivate', 'error');
    }
  }

  // ── Print attendance QR ──────────────────────────────────
  // The QR encodes the operator's employee_id. This is the same value
  // matched by clockIn/getOperatorByCode for the ATTENDANCE scanner station.
  // It is NOT the legacy operators_v0.qr_code used by scannerLogin — scanner
  // station login still requires a QR card from the legacy table until that
  // login flow migrates to public.operators.
  function printOperatorQr(op) {
    if (!op.employee_id) { showToast('No employee_id for this operator', 'error'); return; }
    const deptLabel = (DEPT_LABEL[op.department] || op.department || '').toUpperCase();
    const supBadge  = op.is_supervisor ? ' · SUPERVISOR' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Attendance QR — ${escapeHtml(op.name)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  body{margin:0;padding:20px;font-family:'JetBrains Mono',monospace;background:#fff;display:flex;justify-content:center}
  .card{width:240px;border:2px solid #000;border-radius:10px;padding:20px;display:flex;flex-direction:column;align-items:center;gap:10px}
  .logo{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:#555;margin-bottom:2px}
  .name{font-size:15px;font-weight:700;text-align:center;line-height:1.2}
  .role{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555}
  .qr{margin:8px 0}
  .code{font-size:10px;color:#333;letter-spacing:.06em;font-weight:700}
  .sub{font-size:8px;color:#888;letter-spacing:.06em}
  @media print{body{padding:0}@page{margin:10mm}}
<\/style></head><body>
<div class="card">
  <div class="logo">Legend of Toys</div>
  <div class="name">${escapeHtml(op.name)}</div>
  <div class="role">${escapeHtml(deptLabel)}${escapeHtml(supBadge)}</div>
  <div class="qr" id="qr"></div>
  <div class="code">${escapeHtml(op.employee_id)}</div>
  <div class="sub">ATTENDANCE</div>
</div>
<script>
  function render() {
    new QRCode(document.getElementById('qr'), {
      text: ${JSON.stringify(op.employee_id)}, width:120, height:120,
      colorDark:'#000000', colorLight:'#ffffff', correctLevel: QRCode.CorrectLevel.H
    });
  }
  if (typeof QRCode === 'undefined') {
    setTimeout(function() { render(); setTimeout(function(){ window.print(); }, 500); }, 600);
  } else {
    render();
    setTimeout(function(){ window.print(); }, 500);
  }
<\/script>
</body></html>`;
    printWindow(html);
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <style>{`.rl-op-row:hover { background: var(--surface-2); }`}</style>

      {/* Add/Edit Modal */}
      {modal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'grid', placeItems: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !mSaving) setModal(null); }}
        >
          <div style={{ width: 480, maxWidth: '92vw', background: 'var(--surface)', border: '1px solid var(--border-2)',
            borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-pop)', animation: 'rl-pop-in 200ms var(--ease)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="users" size={18} style={{ color: 'var(--yellow)' }} />
              <span className="label" style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {modal.mode === 'add' ? 'Add operator' : `Edit · ${modal.op?.name || ''}`}
              </span>
            </div>

            <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {modal.mode === 'edit' && modal.op?.employee_id && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)' }}>
                  Employee ID · <span className="num" style={{ color: 'var(--t1)', fontSize: 12 }}>{modal.op.employee_id}</span>
                </div>
              )}

              <div>
                <div className="eyebrow" style={{ marginBottom: 7 }}>Full name <span style={{ color: 'var(--bad-fg)' }}>*</span></div>
                <input autoFocus style={modalInput} value={mName} onChange={e => setMName(e.target.value)} placeholder="Operator name" />
              </div>

              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>Department</div>
                  <select style={{ ...selectStyle, width: '100%' }} value={mDept} onChange={e => setMDept(e.target.value)}>
                    {DEPARTMENTS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>Type</div>
                  <select style={{ ...selectStyle, width: '100%' }} value={mType} onChange={e => setMType(e.target.value)}>
                    {EMPLOYMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 14 }}>
                {modal.mode === 'edit' && (
                  <div style={{ flex: 1 }}>
                    <div className="eyebrow" style={{ marginBottom: 7 }}>Status</div>
                    <select style={{ ...selectStyle, width: '100%' }} value={mStatus} onChange={e => setMStatus(e.target.value)}>
                      {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>Phone (optional)</div>
                  <input style={modalInput} value={mPhone} onChange={e => setMPhone(e.target.value)} placeholder="" />
                </div>
              </div>

              {modal.mode === 'add' && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>
                  Employee ID auto-assigned · <span className="num" style={{ fontSize: 11 }}>LOT-FACT-####</span>. A QR badge is generated on save.
                </div>
              )}

              {mError && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--bad-fg)' }}>{mError}</div>
              )}
            </div>

            <div style={{ padding: '16px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)} style={{ ...btnGhost, padding: '9px 16px' }} disabled={mSaving}>Cancel</button>
              <button
                onClick={submitModal}
                disabled={mSaving}
                style={{ ...btnPrimary, padding: '9px 18px', opacity: mSaving ? 0.5 : 1 }}
              >
                {mSaving ? 'Saving…' : (modal.mode === 'add' ? 'Save operator' : 'Save changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, maxWidth: 320, minWidth: 220, display: 'flex', alignItems: 'center', gap: 9,
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '9px 12px' }}>
          <Icon name="search" size={15} style={{ color: 'var(--t3)' }} />
          <input
            data-search-primary
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name / employee ID  · /"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--t1)',
              fontFamily: 'var(--font-ui)', fontSize: 13, minWidth: 0 }}
          />
        </div>
        <select style={selectStyle} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="">All Departments</option>
          {DEPARTMENTS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button style={btnGhost} onClick={loadData} disabled={loading}>
          <Icon name="activity" size={13} /> Refresh
        </button>
        {canEdit && (
          <button onClick={openAdd} style={{ ...btnPrimary, padding: '9px 16px', whiteSpace: 'nowrap' }}>
            <Icon name="plus" size={15} /> Add Operator
          </button>
        )}
      </div>

      {/* Directory */}
      <Panel pad={8}>
        {loading && operators.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : displayRows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
            No operators match these filters.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '4px 12px 9px',
              borderBottom: '1px solid var(--border)', minWidth: 880 }}>
              {['Name', 'Employee ID', 'Department', 'Type', 'Status', 'Actions'].map(h => (
                <div key={h} className="eyebrow">{h}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {displayRows.map((op, i) => {
                const inactive = (op.status || '').toLowerCase() !== 'active';
                return (
                  <div key={op.id} className="rl-op-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12,
                    alignItems: 'center', padding: '10px 12px', borderTop: i ? '1px solid var(--border)' : 'none',
                    minWidth: 880, opacity: inactive ? 0.55 : 1, transition: 'background var(--fast) var(--ease)' }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--t1)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      textTransform: 'uppercase', letterSpacing: '0.02em' }}>{op.name}</span>
                    <span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{op.employee_id || '—'}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{DEPT_LABEL[op.department] || op.department || '—'}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>{op.employment_type === 'contract' ? 'Contract' : 'In House'}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: !inactive ? 'var(--green)' : 'var(--t4)' }} />
                      <span className="num" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                        color: !inactive ? 'var(--ok-fg)' : 'var(--t3)' }}>
                        {!inactive ? 'Active' : (op.status || 'Inactive')}
                      </span>
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => printOperatorQr(op)} style={actionBtn('var(--blue-bright)')}>
                        <Icon name="qr" size={12} /> QR
                      </button>
                      {canEdit && (
                        <>
                          <button onClick={() => openEdit(op)} style={actionBtn('var(--yellow)')}>Edit</button>
                          {!inactive && (
                            <button onClick={() => deactivate(op)} style={{ ...actionBtn('var(--bad-fg)'), borderColor: 'var(--bad-bd)' }}>
                              Deactivate
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Panel>

      <div style={{ marginTop: 12, fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', textAlign: 'center' }}>
        {displayRows.length} of {operators.length} operators · feeds Attendance &amp; Manpower
      </div>
    </div>
  );
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
