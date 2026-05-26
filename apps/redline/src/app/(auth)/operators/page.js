'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast, printWindow, useEscapeClose } from '@throttle/ui';

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
const primaryBtn    = { padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a', border: '1px solid var(--yellow)', borderRadius: 3, fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const secondaryBtn  = { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' };
const smallBtn      = { padding: '5px 11px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer', letterSpacing: '0.04em' };
const inputStyle    = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '8px 12px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
const selectStyle   = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontSize: 13, fontFamily: 'var(--mono)', padding: '8px 12px', borderRadius: 3 };
const labelStyle    = { fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6, fontFamily: 'var(--mono)' };
const sectionLabel  = { fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)', margin: 0 };
const thStyle       = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle       = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

// ── Operators Page ───────────────────────────────────────────
export default function OperatorsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

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
    try {
      const res = await workerFetch('getOperators', { data: {} }, session);
      const rows = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
      setOperators(rows);
    } catch (e) {
      showToast(e?.message || 'Failed to load operators', 'error');
      setOperators([]);
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

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
    <>
      {/* Add/Edit Modal */}
      {modal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !mSaving) setModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 480, maxWidth: '92vw' }}>
            <h2 style={{ ...sectionLabel, color: 'var(--yellow)', marginBottom: 16 }}>
              {modal.mode === 'add' ? 'Add Operator' : `Edit ${modal.op?.name}`}
            </h2>
            {modal.mode === 'edit' && modal.op?.employee_id && (
              <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--t3)' }}>
                Employee ID: <span style={{ color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{modal.op.employee_id}</span>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input style={{ ...inputStyle, width: '100%' }} value={mName} onChange={e => setMName(e.target.value)} placeholder="Full name" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Department</label>
                <select style={{ ...selectStyle, width: '100%' }} value={mDept} onChange={e => setMDept(e.target.value)}>
                  {DEPARTMENTS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Employment</label>
                <select style={{ ...selectStyle, width: '100%' }} value={mType} onChange={e => setMType(e.target.value)}>
                  {EMPLOYMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {modal.mode === 'edit' && (
                <div>
                  <label style={labelStyle}>Status</label>
                  <select style={{ ...selectStyle, width: '100%' }} value={mStatus} onChange={e => setMStatus(e.target.value)}>
                    {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label style={labelStyle}>Phone (optional)</label>
                <input style={{ ...inputStyle, width: '100%' }} value={mPhone} onChange={e => setMPhone(e.target.value)} placeholder="" />
              </div>
            </div>

            {mError && <div style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10, fontFamily: 'var(--mono)' }}>{mError}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setModal(null)} style={secondaryBtn} disabled={mSaving}>Cancel</button>
              <button
                onClick={submitModal}
                disabled={mSaving}
                style={{ ...primaryBtn, opacity: mSaving ? 0.5 : 1 }}
              >
                {mSaving ? 'Saving…' : (modal.mode === 'add' ? 'Add' : 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          data-search-primary
          style={{ ...inputStyle, width: 220 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name / employee ID  · /"
        />
        <select style={selectStyle} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="">All Departments</option>
          {DEPARTMENTS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button style={secondaryBtn} onClick={loadData} disabled={loading}>↻ Refresh</button>
        {canEdit && (
          <button onClick={openAdd} style={primaryBtn}>
            + Add Operator
          </button>
        )}
      </div>

      {/* Table */}
      <Panel padding={0}>
        {loading && operators.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : displayRows.length === 0 ? (
          <EmptyState icon="👥" message="No operators match these filters" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Name','Employee ID','Department','Type','Status','Actions'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(op => {
                  const inactive = (op.status || '').toLowerCase() !== 'active';
                  return (
                    <tr key={op.id} style={{ opacity: inactive ? 0.55 : 1 }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{op.name}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{op.employee_id || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{DEPT_LABEL[op.department] || op.department || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{op.employment_type === 'contract' ? 'Contract' : 'In House'}</td>
                      <td style={tdStyle}>
                        {(op.status || '').toLowerCase() === 'active'
                          ? <StatusBadge variant="success" icon="●">Active</StatusBadge>
                          : <StatusBadge variant="neutral">{op.status || 'Inactive'}</StatusBadge>}
                      </td>
                      <td style={tdStyle}>
                        <button onClick={() => printOperatorQr(op)} style={{ ...smallBtn, color: 'var(--state-info, #7b93ff)', borderColor: 'var(--state-info, #7b93ff)', marginRight: 4 }}>
                          🖨 QR
                        </button>
                        {canEdit && (
                          <>
                            <button onClick={() => openEdit(op)} style={{ ...smallBtn, color: 'var(--yellow)', borderColor: 'var(--yellow)', marginRight: 4 }}>
                              Edit
                            </button>
                            {!inactive && (
                              <button
                                onClick={() => deactivate(op)}
                                style={{ ...smallBtn, color: 'var(--red)', borderColor: 'var(--red)' }}
                              >
                                Deactivate
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
        Showing {displayRows.length} of {operators.length} operators
      </div>
    </>
  );
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
