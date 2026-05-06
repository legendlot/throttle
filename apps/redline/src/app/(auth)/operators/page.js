'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast, printWindow } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

// ── Constants ────────────────────────────────────────────────
const ROLE_LABELS = {
  assembly:           'Assembly',
  qc_inline:          'QC Inline',
  qc_audit:           'QC Audit',
  repair:             'Repair',
  packing:            'Packing',
  rtd:                'RTD',
  store:              'Store',
  supervisor:         'Supervisor',
  line_manager:       'Line Manager',
  production_manager: 'Production Manager',
  admin:              'Admin',
};

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
}

// ── Common styles ────────────────────────────────────────────
const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
const inputStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12 };
const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontSize: 11, fontFamily: 'var(--mono)', padding: '5px 8px', borderRadius: 3 };
const labelStyle = { fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 };
const sectionLabel = { fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)' };
const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

// ── Operators Page ───────────────────────────────────────────
export default function OperatorsPage() {
  const { session, role } = useAuth();
  const { showToast } = useToast();

  const canEdit = ['admin', 'production_manager'].includes(role);

  const [operators,   setOperators]   = useState([]);
  const [sessions,    setSessions]    = useState({});
  const [loading,     setLoading]     = useState(false);

  const [roleFilter,  setRoleFilter]  = useState('');
  const [lineFilter,  setLineFilter]  = useState('');
  const [activeOnly,  setActiveOnly]  = useState(true);

  // Modal state
  const [modal,       setModal]       = useState(null);
  const [mName,       setMName]       = useState('');
  const [mRole,       setMRole]       = useState('assembly');
  const [mLine,       setMLine]       = useState('');
  const [mError,      setMError]      = useState('');
  const [mSaving,     setMSaving]     = useState(false);

  const loadData = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const today = todayStr();
      const [opsRes, sesRes] = await Promise.allSettled([
        garageFetch('getOperators',         { active: 'false' }, session),
        garageFetch('getOperatorSessions',  { date_from: today, date_to: today }, session),
      ]);
      const ops = opsRes.status === 'fulfilled' && Array.isArray(opsRes.value) ? opsRes.value : [];
      setOperators(ops);
      const ses = sesRes.status === 'fulfilled' && Array.isArray(sesRes.value) ? sesRes.value : [];
      const counts = {};
      for (const s of ses) {
        if (!s.operator_id) continue;
        counts[s.operator_id] = (counts[s.operator_id] || 0) + 1;
      }
      setSessions(counts);
    } catch (_) {
      setOperators([]); setSessions({});
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtered rows ─────────────────────────────────────────
  const displayRows = operators
    .filter(o => activeOnly ? o.is_active : true)
    .filter(o => roleFilter ? o.role === roleFilter : true)
    .filter(o => lineFilter ? o.line === lineFilter : true);

  // ── Modal handlers ────────────────────────────────────────
  function openAdd() {
    setModal({ mode: 'add', op: null });
    setMName(''); setMRole('assembly'); setMLine(''); setMError('');
  }

  function openEdit(op) {
    setModal({ mode: 'edit', op });
    setMName(op.name || '');
    setMRole(op.role || 'assembly');
    setMLine(op.line || '');
    setMError('');
  }

  async function submitModal() {
    if (!mName.trim()) { setMError('Name is required'); return; }
    setMSaving(true); setMError('');
    const payload = { name: mName.trim(), role: mRole };
    if (modal.mode === 'edit') payload.id = modal.op.id;
    if (mLine) payload.line = mLine;
    try {
      // saveOperator is a GET action — use garageFetch
      await garageFetch('saveOperator', payload, session);
      setModal(null);
      showToast(modal.mode === 'add' ? 'Operator added' : 'Operator updated', 'success');
      await loadData();
    } catch (e) {
      setMError(e.message || 'Save failed');
    } finally {
      setMSaving(false);
    }
  }

  async function toggleActive(op) {
    try {
      await garageFetch('saveOperator', { id: op.id, is_active: String(!op.is_active) }, session);
      showToast(op.is_active ? 'Operator deactivated' : 'Operator reactivated', 'success');
      await loadData();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  // ── Print operator QR ─────────────────────────────────────
  function printOperatorQr(op) {
    if (!op.qr_code) { showToast('No QR code for this operator', 'error'); return; }
    const roleLabel = (ROLE_LABELS[op.role] || op.role || '').toUpperCase();
    const lineLabel = op.line ? ' · ' + op.line : '';
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>QR Card — ${op.name}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  body{margin:0;padding:20px;font-family:'JetBrains Mono',monospace;background:#fff;display:flex;justify-content:center}
  .card{width:240px;border:2px solid #000;border-radius:10px;padding:20px;display:flex;flex-direction:column;align-items:center;gap:10px}
  .logo{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:#555;margin-bottom:2px}
  .name{font-size:15px;font-weight:700;text-align:center;line-height:1.2}
  .role{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555}
  .qr{margin:8px 0}
  .code{font-size:8px;color:#aaa;letter-spacing:.06em}
  @media print{body{padding:0}@page{margin:10mm}}
<\/style></head><body>
<div class="card">
  <div class="logo">Legend of Toys</div>
  <div class="name">${op.name}</div>
  <div class="role">${roleLabel}${lineLabel}</div>
  <div class="qr" id="qr"></div>
  <div class="code">${op.qr_code}</div>
</div>
<script>
  function render() {
    new QRCode(document.getElementById('qr'), {
      text: ${JSON.stringify(op.qr_code)}, width:120, height:120,
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

  return (
    <>
      {/* Add/Edit Modal */}
      {modal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 460, maxWidth: '90vw' }}>
            <div style={{ ...sectionLabel, color: 'var(--yellow)', marginBottom: 16 }}>
              {modal.mode === 'add' ? 'Add Operator' : `Edit ${modal.op?.name}`}
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input style={{ ...inputStyle, width: '100%' }} value={mName} onChange={e => setMName(e.target.value)} placeholder="Full name" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Role</label>
                <select style={{ ...selectStyle, width: '100%' }} value={mRole} onChange={e => setMRole(e.target.value)}>
                  {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Line (optional)</label>
                <select style={{ ...selectStyle, width: '100%' }} value={mLine} onChange={e => setMLine(e.target.value)}>
                  <option value="">— None —</option>
                  <option value="L1">L1</option>
                  <option value="L2">L2</option>
                  <option value="L3">L3</option>
                </select>
              </div>
            </div>
            {mError && <div style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10, fontFamily: 'var(--mono)' }}>{mError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setModal(null)} style={btnStyle} disabled={mSaving}>Cancel</button>
              <button
                onClick={submitModal}
                disabled={mSaving}
                style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)', opacity: mSaving ? 0.5 : 1 }}
              >
                {mSaving ? 'Saving…' : (modal.mode === 'add' ? 'Add' : 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div>
        {/* Filter bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <select style={selectStyle} value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
            <option value="">All Roles</option>
            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select style={selectStyle} value={lineFilter} onChange={e => setLineFilter(e.target.value)}>
            <option value="">All Lines</option>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} />
            Active only
          </label>
          <div style={{ flex: 1 }} />
          <button style={btnStyle} onClick={loadData} disabled={loading}>↻ Refresh</button>
          {canEdit && (
            <button onClick={openAdd} style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)' }}>
              + Add Operator
            </button>
          )}
        </div>

        {/* Table */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {loading && operators.length === 0 ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <EmptyState icon="👥" message="No operators match these filters" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Name','Role','Line','Status','QR Generated','Sessions Today','Actions'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(op => {
                    const inactive = !op.is_active;
                    return (
                      <tr key={op.id} style={{ opacity: inactive ? 0.45 : 1 }}>
                        <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 600 }}>{op.name}</td>
                        <td style={{ ...tdStyle, color: 'var(--t2)' }}>{ROLE_LABELS[op.role] || op.role || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{op.line || '—'}</td>
                        <td style={tdStyle}>
                          {op.is_active
                            ? <span style={{ color: 'var(--green)', fontSize: 11, fontWeight: 700 }}>Active</span>
                            : <span style={{ color: 'var(--t3)', fontSize: 11 }}>Inactive</span>}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                          {op.qr_generated_at ? formatDate(op.qr_generated_at) : '—'}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t1)', textAlign: 'center' }}>
                          {sessions[op.id] || 0}
                        </td>
                        <td style={tdStyle}>
                          <button onClick={() => printOperatorQr(op)} style={{ ...btnStyle, color: 'var(--blue)', borderColor: 'var(--blue)', marginRight: 4 }}>
                            🖨 QR
                          </button>
                          {canEdit && (
                            <>
                              <button onClick={() => openEdit(op)} style={{ ...btnStyle, color: 'var(--yellow)', borderColor: 'var(--yellow)', marginRight: 4 }}>
                                Edit
                              </button>
                              <button
                                onClick={() => toggleActive(op)}
                                style={{ ...btnStyle, color: op.is_active ? 'var(--red)' : 'var(--green)', borderColor: op.is_active ? 'var(--red)' : 'var(--green)' }}
                              >
                                {op.is_active ? 'Deactivate' : 'Reactivate'}
                              </button>
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
        </div>
      </div>
    </>
  );
}
