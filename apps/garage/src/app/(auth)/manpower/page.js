'use client';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, useToast, Modal, ConfirmModal, Badge, DataTable, EmptyState } from '@throttle/ui';
import QRCode from 'qrcode';

// Line accent colours — used in Daily Roster.
const LINE_COLORS = { L1: '#22c55e', L2: '#3b82f6', L3: '#a855f7' };

// ── Shared styles ──────────────────────────────────────────────────────────
const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

// ── Display helpers ─────────────────────────────────────────────────────────
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
function fmtEmpType(t) { return t === 'in_house' ? 'In House' : t === 'contract' ? 'Contract' : (t || '—'); }
function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

// ─── Manpower page (4 tabs) ────────────────────────────────────────────────
export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('operators');
  // Page-level operators cache, shared by Attendance / Daily Roster / Performance.
  // Operators tab has its own filter-driven fetch — it does not consume this.
  const [allOperators, setAllOperators] = useState([]);

  // canManageFloor mirrors worker.js's canManageFloor predicate.
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  useEffect(() => {
    if (!session || !canManageFloor) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await workerFetch('getOperators', { data: { status: '' } }, session);
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setAllOperators(list);
      } catch (e) {
        if (!cancelled) showToast(e.message || 'Failed to load operators', 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [session, canManageFloor, showToast]);

  if (perms && !perms.dashboard) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Manpower
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Operator master, attendance, roster, and performance.
        </p>
      </div>

      <TabBar
        tabs={[
          { key: 'operators',   label: 'Operators' },
          { key: 'attendance',  label: 'Attendance' },
          { key: 'roster',      label: 'Daily Roster' },
          { key: 'performance', label: 'Performance' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'operators'   && <OperatorsTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'attendance'  && <AttendanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'roster'      && <DailyRosterTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'performance' && <PerformanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
    </div>
  );
}

// ── TabBar ──────────────────────────────────────────────────────────────────
function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: on ? '2px solid var(--yellow)' : '2px solid transparent',
              padding: '8px 14px',
              fontFamily: 'var(--cond)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: on ? 'var(--yellow)' : 'var(--t2)',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OperatorsTab — list + filters + create/edit modals
// ═══════════════════════════════════════════════════════════════════════════
function OperatorsTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: 'active', department: '', employment_type: '', search: '' });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState(null);

  // Debounce search field
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const body = { data: {} };
      if (filters.status)          body.data.status          = filters.status;
      if (filters.department)      body.data.department      = filters.department;
      if (filters.employment_type) body.data.employment_type = filters.employment_type;
      if (debouncedSearch.trim())  body.data.search          = debouncedSearch.trim();
      const res = await workerFetch('getOperators', body, session);
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setOperators(rows);
    } catch (e) {
      showToast(e.message || 'Failed to load operators', 'error');
      setOperators([]);
    } finally {
      setLoading(false);
    }
  }, [session, filters.status, filters.department, filters.employment_type, debouncedSearch, showToast]);

  useEffect(() => { load(); }, [load]);

  async function handlePrintQr(op) {
    try {
      const dataUrl = await QRCode.toDataURL(op.employee_id, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      const safeName = (op.name || '').replace(/[<>&"]/g, '');
      const safeDept = (op.department || '').replace(/[<>&"]/g, '');
      const html = `<!DOCTYPE html><html><head>
  <title>QR — ${op.employee_id}</title>
  <style>
    @page { size: 85mm 54mm; margin: 0; }
    html, body { margin: 0; padding: 0; }
    body { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; }
    .card {
      width: 85mm; height: 54mm;
      padding: 8mm;
      display: flex; align-items: center; gap: 6mm;
      border: 1px solid #ccc;
      box-sizing: border-box;
    }
    .meta { display: flex; flex-direction: column; }
    .brand { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
    .empid { font-size: 18px; font-weight: bold; margin: 3px 0; }
    .name { font-size: 13px; }
    .dept { font-size: 11px; color: #666; text-transform: capitalize; }
  </style>
</head><body onload="window.print(); window.onafterprint = function(){ window.close(); };">
  <div class="card">
    <img src="${dataUrl}" width="80" height="80" alt="QR" />
    <div class="meta">
      <div class="brand">Legend of Toys</div>
      <div class="empid">${op.employee_id}</div>
      <div class="name">${safeName}</div>
      <div class="dept">${safeDept}</div>
    </div>
  </div>
</body></html>`;
      const w = window.open('', '_blank', 'width=420,height=320');
      if (!w) { showToast('Pop-up blocked — allow pop-ups for this site', 'error'); return; }
      w.document.write(html);
      w.document.close();
    } catch (e) {
      showToast(e.message || 'QR generation failed', 'error');
    }
  }

  const columns = [
    { key: 'employee_id',     label: 'Employee ID' },
    { key: 'name',            label: 'Name' },
    { key: 'department',      label: 'Department' },
    { key: 'employment_type', label: 'Type' },
    { key: 'status',          label: 'Status' },
    { key: 'phone',           label: 'Phone' },
    { key: 'join_date',       label: 'Join Date' },
    { key: '_actions',        label: '' },
  ];

  function renderCell(row, c) {
    switch (c.key) {
      case 'employee_id':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{row.employee_id}</span>;
      case 'department':
        return capitalize(row.department);
      case 'employment_type':
        return fmtEmpType(row.employment_type);
      case 'status':
        return (
          <Badge color={row.status === 'active' ? 'var(--green)' : 'var(--t3)'}>
            {(row.status || '').toUpperCase()}
          </Badge>
        );
      case 'phone':
        return row.phone || '—';
      case 'join_date':
        return fmtDate(row.join_date);
      case '_actions':
        return (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={(e) => { e.stopPropagation(); handlePrintQr(row); }}
              style={{ ...btnSecondary, padding: '4px 8px' }}
              title="Print QR card"
            >
              ⎙ Print QR
            </button>
            {canManageFloor && (
              <button
                onClick={(e) => { e.stopPropagation(); setEditTarget(row); }}
                style={{ ...btnSecondary, padding: '4px 8px' }}
                title="Edit"
              >
                ✎ Edit
              </button>
            )}
          </div>
        );
      default:
        return row[c.key];
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px', minWidth: 180 }}>
            <span style={labelStyle}>Search name</span>
            <input
              type="text"
              placeholder="Filter by name…"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div>
            <span style={labelStyle}>Department</span>
            <select
              value={filters.department}
              onChange={(e) => setFilters({ ...filters, department: e.target.value })}
              style={selectStyle}
            >
              <option value="">All</option>
              <option value="assembly">Assembly</option>
              <option value="qc">QC</option>
              <option value="packaging">Packaging</option>
            </select>
          </div>
          <div>
            <span style={labelStyle}>Type</span>
            <select
              value={filters.employment_type}
              onChange={(e) => setFilters({ ...filters, employment_type: e.target.value })}
              style={selectStyle}
            >
              <option value="">All</option>
              <option value="in_house">In House</option>
              <option value="contract">Contract</option>
            </select>
          </div>
          <div>
            <span style={labelStyle}>Status</span>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              style={selectStyle}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="">All</option>
            </select>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            {canManageFloor && (
              <button onClick={() => setShowCreate(true)} style={btnPrimary}>
                + Add Operator
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          <DataTable
            columns={columns}
            rows={operators}
            loading={loading}
            emptyMessage="No operators found"
            renderCell={renderCell}
          />
        </div>
      </div>

      <CreateOperatorModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        session={session}
        onSaved={(empId) => {
          setShowCreate(false);
          showToast(`Operator added — ${empId || 'created'}`, 'success');
          load();
        }}
      />

      <EditOperatorModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        session={session}
        onSaved={() => {
          setEditTarget(null);
          showToast('Operator updated', 'success');
          load();
        }}
      />
    </div>
  );
}

// ── CreateOperatorModal ─────────────────────────────────────────────────────
function CreateOperatorModal({ open, onClose, session, onSaved }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('assembly');
  const [employmentType, setEmploymentType] = useState('in_house');
  const [phone, setPhone] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [dob, setDob] = useState('');
  const [legacyId, setLegacyId] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form whenever modal opens fresh
  useEffect(() => {
    if (open) {
      setName(''); setDepartment('assembly'); setEmploymentType('in_house');
      setPhone(''); setJoinDate(''); setDob(''); setLegacyId(''); setSaving(false);
    }
  }, [open]);

  async function save() {
    if (!name.trim())     { showToast('Name required', 'error'); return; }
    if (!department)      { showToast('Department required', 'error'); return; }
    if (!employmentType)  { showToast('Employment Type required', 'error'); return; }
    if (!phone.trim())    { showToast('Phone required', 'error'); return; }
    if (!joinDate)        { showToast('Join Date required', 'error'); return; }
    if (!dob)             { showToast('Date of Birth required', 'error'); return; }
    setSaving(true);
    try {
      const res = await workerFetch('createOperator', {
        data: {
          name:               name.trim(),
          department,
          employment_type:    employmentType,
          phone:              phone.trim() || null,
          join_date:          joinDate || null,
          date_of_birth:      dob || null,
          legacy_employee_id: legacyId.trim() || null,
        },
      }, session);
      const row = res?.data || res;
      onSaved?.(row?.employee_id);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Operator"
      size="lg"
      confirmLabel={saving ? 'Saving…' : 'Save'}
      onConfirm={save}
      loading={saving}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Field label="Name *"><input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Department *">
          <select value={department} onChange={(e) => setDepartment(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="assembly">Assembly</option>
            <option value="qc">QC</option>
            <option value="packaging">Packaging</option>
          </select>
        </Field>
        <Field label="Employment Type *">
          <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} required style={{ ...selectStyle, width: '100%' }}>
            <option value="in_house">In House</option>
            <option value="contract">Contract</option>
          </select>
        </Field>
        <Field label="Phone *"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Join Date *"><input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} required style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Date of Birth *"><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} required style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Legacy Employee ID" full>
          <input type="text" value={legacyId} onChange={(e) => setLegacyId(e.target.value)} placeholder="G00XXX (old ID)" style={{ ...inputStyle, width: '100%' }} />
        </Field>
      </div>
    </Modal>
  );
}

// ── EditOperatorModal ───────────────────────────────────────────────────────
function EditOperatorModal({ target, onClose, session, onSaved }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('assembly');
  const [employmentType, setEmploymentType] = useState('in_house');
  const [status, setStatus] = useState('active');
  const [phone, setPhone] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [dob, setDob] = useState('');
  const [legacyId, setLegacyId] = useState('');
  const [pan, setPan] = useState('');
  const [docRef, setDocRef] = useState('');
  const [saving, setSaving] = useState(false);

  // Seed form from target whenever it changes
  useEffect(() => {
    if (!target) return;
    setName(target.name || '');
    setDepartment(target.department || 'assembly');
    setEmploymentType(target.employment_type || 'in_house');
    setStatus(target.status || 'active');
    setPhone(target.phone || '');
    setJoinDate(target.join_date || '');
    setDob(target.date_of_birth || '');
    setLegacyId(target.legacy_employee_id || '');
    setPan('');     // sensitive — getOperators omits these
    setDocRef('');  // sensitive — getOperators omits these
    setSaving(false);
  }, [target]);

  async function save() {
    if (!target) return;
    if (!name.trim())  { showToast('Name required', 'error'); return; }
    if (!department)   { showToast('Department required', 'error'); return; }
    setSaving(true);
    try {
      const body = {
        operator_id:        target.id,
        name:               name.trim(),
        department,
        employment_type:    employmentType,
        status,
        phone:              phone.trim() || null,
        join_date:          joinDate || null,
        date_of_birth:      dob || null,
        legacy_employee_id: legacyId.trim() || null,
      };
      // Only send sensitive fields if the user entered something — keeps existing DB value otherwise.
      if (pan.trim())    body.pan_number      = pan.trim();
      if (docRef.trim()) body.id_document_ref = docRef.trim();
      await workerFetch('updateOperator', { data: body }, session);
      onSaved?.();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!target) return null;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`Edit Operator — ${target.employee_id}`}
      size="lg"
      confirmLabel={saving ? 'Saving…' : 'Save Changes'}
      onConfirm={save}
      loading={saving}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, marginBottom: 12 }}>
        <span style={labelStyle}>Employee ID (immutable)</span>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>{target.employee_id}</div>
        <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>Created {fmtDate(target.created_at)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Name *"><input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Department *">
          <select value={department} onChange={(e) => setDepartment(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="assembly">Assembly</option>
            <option value="qc">QC</option>
            <option value="packaging">Packaging</option>
          </select>
        </Field>
        <Field label="Employment Type">
          <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="in_house">In House</option>
            <option value="contract">Contract</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
        <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Join Date"><input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Date of Birth"><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Legacy Employee ID"><input type="text" value={legacyId} onChange={(e) => setLegacyId(e.target.value)} placeholder="G00XXX (old ID)" style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="PAN Number" full>
          <input type="text" value={pan} onChange={(e) => setPan(e.target.value)} placeholder="ABCDE1234F" style={{ ...inputStyle, width: '100%' }} />
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>Leave blank to keep existing value.</div>
        </Field>
        <Field label="ID Document Ref" full>
          <input type="text" value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="Doc ref / filename" style={{ ...inputStyle, width: '100%' }} />
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>Leave blank to keep existing value.</div>
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, full, children }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AttendanceTab — daily clock-in/out view with close-shift action.
// Uses worker actions getOperatorAttendance (date_from/date_to/operator_id/department)
// and closeAttendanceShift (attendance_id). Worker requires canManageFloor for both,
// so the entire tab is gated on canManageFloor.
// ═══════════════════════════════════════════════════════════════════════════
function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtIstTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch { return null; }
}

function fmtDuration(clockIn, clockOut) {
  if (!clockIn || !clockOut) return '—';
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function AttendanceTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closing, setClosing] = useState(false);

  // employee_id lookup — worker attendance rows include name+department but no employee_id.
  const opMap = useMemo(() => {
    const m = {};
    for (const op of operators || []) m[op.id] = op;
    return m;
  }, [operators]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const res = await workerFetch(
        'getOperatorAttendance',
        { data: { date_from: date, date_to: date } },
        session
      );
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRows(list);
    } catch (e) {
      showToast(e.message || 'Failed to load attendance', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

  async function confirmClose() {
    if (!closeTarget) return;
    setClosing(true);
    try {
      const res = await workerFetch(
        'closeAttendanceShift',
        { data: { attendance_id: closeTarget.id } },
        session
      );
      // Worker returns { ok:false, error } for already-closed/not-found cases inside data
      const inner = res?.data;
      if (inner && inner.ok === false) {
        showToast(inner.error || 'Could not close shift', 'error');
      } else {
        showToast(`Shift closed for ${closeTarget.operator_name || 'operator'}`, 'success');
      }
      setCloseTarget(null);
      load();
    } catch (e) {
      showToast(e.message || 'Close shift failed', 'error');
    } finally {
      setClosing(false);
    }
  }

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Attendance is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  const columns = [
    { key: 'employee_id', label: 'Employee ID' },
    { key: 'name',        label: 'Name' },
    { key: 'department',  label: 'Department' },
    { key: 'shift',       label: 'Shift' },
    { key: 'clock_in',    label: 'Clock In' },
    { key: 'clock_out',   label: 'Clock Out' },
    { key: 'duration',    label: 'Duration' },
    { key: 'device',      label: 'Device' },
    { key: '_actions',    label: '' },
  ];

  function renderCell(row, c) {
    const op = opMap[row.operator_id];
    switch (c.key) {
      case 'employee_id':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{op?.employee_id || '—'}</span>;
      case 'name':
        return row.operator_name || op?.name || '—';
      case 'department':
        return capitalize(row.operator_department || op?.department || '');
      case 'shift':
        return capitalize(row.shift_type || '');
      case 'clock_in':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtIstTime(row.clock_in) || '—'}</span>;
      case 'clock_out':
        return row.clock_out
          ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtIstTime(row.clock_out)}</span>
          : <Badge color="var(--yellow)">OPEN</Badge>;
      case 'duration':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{fmtDuration(row.clock_in, row.clock_out)}</span>;
      case 'device':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{row.clock_in_device || '—'}</span>;
      case '_actions':
        if (row.clock_out) return null;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setCloseTarget(row); }}
            style={{ ...btnSecondary, padding: '4px 8px' }}
            title="Close shift"
          >
            Close Shift
          </button>
        );
      default:
        return row[c.key];
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {rows.length} record{rows.length === 1 ? '' : 's'}
            </span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState message={`No attendance records for ${date}`} />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              loading={false}
              emptyMessage=""
              renderCell={renderCell}
            />
          )}
        </div>
      </div>

      <ConfirmModal
        open={!!closeTarget}
        onClose={() => !closing && setCloseTarget(null)}
        title="Close Shift"
        confirmLabel={closing ? 'Closing…' : 'Close Shift'}
        onConfirm={confirmClose}
        loading={closing}
        message={
          closeTarget
            ? `Close shift for ${closeTarget.operator_name || 'this operator'}? This will set their clock-out to the current time.`
            : ''
        }
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DailyRosterTab — line assignment roster backed by store.manpower_assignments.
// HTML5 drag-and-drop from operators panel into L1/L2/L3 columns + dropdown
// fallback. assignManpower upserts (operator+date+line UNIQUE).
// removeManpower DELETEs a single (operator_id, shift_date, line) row.
// ═══════════════════════════════════════════════════════════════════════════
const ROSTER_SECTIONS = ['Assembly', 'QC', 'Packaging'];

function DailyRosterTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Per-section picker state — keys are "L1-Assembly", "L2-QC", etc.
  const [pickerOpen, setPickerOpen]   = useState({});
  const [pickerQuery, setPickerQuery] = useState({});
  const pickerRefs = useRef({});

  const activeOperators = useMemo(
    () => (operators || []).filter((o) => o.status !== 'inactive'),
    [operators]
  );

  const filteredOperators = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeOperators;
    return activeOperators.filter((o) => (o.name || '').toLowerCase().includes(q));
  }, [activeOperators, search]);

  // operator_id -> line they're already on (for left-panel chip dot)
  const assignedLineByOpId = useMemo(() => {
    const m = {};
    for (const line of ['L1', 'L2', 'L3']) {
      const sections = grouped[line] || {};
      for (const section of Object.keys(sections)) {
        for (const row of sections[section] || []) m[row.operator_id] = line;
      }
    }
    return m;
  }, [grouped]);

  // Set of all assigned operator_ids — used to filter combobox options.
  const assignedOpIds = useMemo(() => {
    const s = new Set();
    for (const line of ['L1', 'L2', 'L3']) {
      const sections = grouped[line] || {};
      for (const section of Object.keys(sections)) {
        for (const row of sections[section] || []) s.add(row.operator_id);
      }
    }
    return s;
  }, [grouped]);

  const totalAssigned = useMemo(() => {
    let n = 0;
    for (const line of ['L1', 'L2', 'L3']) {
      const sections = grouped[line] || {};
      for (const section of Object.keys(sections)) n += (sections[section] || []).length;
    }
    return n;
  }, [grouped]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const res = await workerFetch('getManpowerLog', { data: { shift_date: date } }, session);
      const inner = res?.data;
      const obj = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
      setGrouped(obj);
    } catch (e) {
      showToast(e.message || 'Failed to load roster', 'error');
      setGrouped({});
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

  // Close any open picker on outside click or ESC.
  useEffect(() => {
    const openKeys = Object.keys(pickerOpen).filter((k) => pickerOpen[k]);
    if (openKeys.length === 0) return;
    function onDocClick(e) {
      const stillOpen = {};
      for (const key of openKeys) {
        const el = pickerRefs.current[key];
        if (el && el.contains(e.target)) stillOpen[key] = true;
      }
      setPickerOpen(stillOpen);
    }
    function onKey(e) {
      if (e.key === 'Escape') setPickerOpen({});
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  async function handleAssign(operatorId, line, station) {
    if (!canManageFloor || !operatorId || !line || !station) return;
    try {
      await workerFetch(
        'assignManpower',
        { data: { operator_id: operatorId, line, shift_date: date, station } },
        session
      );
      const op = activeOperators.find((o) => o.id === operatorId);
      showToast(`Assigned ${op?.name || 'operator'} to ${line} · ${station}`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Assign failed', 'error');
    }
  }

  async function handleUnassign(row, line) {
    if (!canManageFloor || !row?.operator_id || !line) return;
    try {
      await workerFetch(
        'removeManpower',
        { data: { operator_id: row.operator_id, line, shift_date: date } },
        session
      );
      showToast(`Removed ${row.operator_name || 'operator'} from ${line}`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Unassign failed', 'error');
    }
  }

  function onDragStart(e, op) {
    e.dataTransfer.setData('operatorId', op.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDropToSection(e, line, station) {
    e.preventDefault();
    const operatorId = e.dataTransfer.getData('operatorId');
    if (operatorId) handleAssign(operatorId, line, station);
  }

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Daily Roster is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {totalAssigned} assigned
            </span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, alignItems: 'start' }}>
        {/* Operators panel */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Operators ({activeOperators.length})</span>
          </div>
          <div style={panelBodyStyle}>
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
            />
            {filteredOperators.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
                {activeOperators.length === 0 ? 'Loading operators…' : 'No matches'}
              </div>
            ) : (
              filteredOperators.map((op) => {
                const assignedLine = assignedLineByOpId[op.id];
                const dotColor = assignedLine ? LINE_COLORS[assignedLine] : null;
                return (
                  <div
                    key={op.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, op)}
                    title={assignedLine ? `Already on ${assignedLine} (drag to a section to reassign)` : 'Drag to a line section'}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', marginBottom: 4,
                      background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3,
                      cursor: 'grab', fontSize: 12, color: 'var(--t1)',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>≡</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{op.name}</span>
                    {dotColor && (
                      <span
                        style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: '0 0 0 1px var(--border)' }}
                        title={`On ${assignedLine}`}
                      />
                    )}
                    <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase' }}>
                      {(op.department || '').slice(0, 4)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Line columns */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {['L1', 'L2', 'L3'].map((line) => {
            const sections = grouped[line] || {};
            const accent = LINE_COLORS[line];
            const lineCount = ROSTER_SECTIONS.reduce((s, sec) => s + ((sections[sec] || []).length), 0)
                            + ((sections.Unassigned || []).length);
            return (
              <div key={line} style={{ ...panelStyle, marginBottom: 0, minHeight: 220 }}>
                <div style={{ ...panelHeaderStyle, color: accent }}>
                  <span>{line} ({lineCount})</span>
                </div>
                <div style={{ padding: 6 }}>
                  {ROSTER_SECTIONS.map((station, idx) => {
                    const rows = sections[station] || [];
                    const key = `${line}-${station}`;
                    const open = !!pickerOpen[key];
                    const q = (pickerQuery[key] || '').trim().toLowerCase();
                    const pickerOps = activeOperators.filter((op) => {
                      if (assignedOpIds.has(op.id)) return false;
                      if (!q) return true;
                      return (op.name || '').toLowerCase().includes(q) ||
                             (op.employee_id || '').toLowerCase().includes(q);
                    });
                    return (
                      <div
                        key={station}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDropToSection(e, line, station)}
                        style={{
                          borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                          padding: '8px 8px 10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                            color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '0.08em',
                          }}>
                            {station} ({rows.length})
                          </span>
                          <div
                            ref={(el) => { pickerRefs.current[key] = el; }}
                            style={{ position: 'relative' }}
                          >
                            <button
                              style={{ ...btnSecondary, padding: '1px 7px', fontSize: 11 }}
                              onClick={() => {
                                setPickerOpen((s) => ({ ...s, [key]: !s[key] }));
                                setPickerQuery((s) => ({ ...s, [key]: '' }));
                              }}
                              title={open ? 'Close' : `Assign to ${station}`}
                            >
                              {open ? '×' : '+'}
                            </button>
                            {open && (
                              <div style={{
                                position: 'absolute', top: '100%', right: 0,
                                marginTop: 4, zIndex: 20, width: 240,
                                background: 'var(--surface2)', border: '1px solid var(--border)',
                                borderRadius: 3, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                              }}>
                                <input
                                  type="text"
                                  autoFocus
                                  placeholder="Search name or ID…"
                                  value={pickerQuery[key] || ''}
                                  onChange={(e) => setPickerQuery((s) => ({ ...s, [key]: e.target.value }))}
                                  style={{ ...inputStyle, width: '100%', borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}
                                />
                                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                                  {pickerOps.length === 0 ? (
                                    <div style={{ padding: '8px 12px', color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                                      No available operators
                                    </div>
                                  ) : (
                                    pickerOps.slice(0, 50).map((op) => (
                                      <div
                                        key={op.id}
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          handleAssign(op.id, line, station);
                                          setPickerOpen((s) => ({ ...s, [key]: false }));
                                          setPickerQuery((s) => ({ ...s, [key]: '' }));
                                        }}
                                        style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: 'var(--t1)' }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                      >
                                        <div>{op.name}</div>
                                        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
                                          {op.employee_id || '—'} · {(op.department || '').toUpperCase()}
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        {loading && idx === 0 ? (
                          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                        ) : rows.length === 0 ? (
                          <div style={{
                            border: '1px dashed var(--border)', borderRadius: 3,
                            padding: '12px 10px', textAlign: 'center',
                            color: 'var(--t3)', fontSize: 10, fontFamily: 'var(--mono)',
                            textTransform: 'uppercase', letterSpacing: '0.08em',
                          }}>
                            Drop operator here
                          </div>
                        ) : (
                          rows.map((row) => (
                            <div
                              key={row.id}
                              style={{
                                background: 'var(--surface2)',
                                border: '1px solid var(--border)',
                                borderLeft: `3px solid ${accent}`,
                                borderRadius: 3,
                                padding: '5px 8px',
                                marginBottom: 4,
                                display: 'flex', alignItems: 'flex-start', gap: 6,
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, color: 'var(--t1)' }}>{row.operator_name || '(unknown)'}</div>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                                  {row.operator_department || '—'}
                                </div>
                              </div>
                              <button
                                onClick={() => handleUnassign(row, line)}
                                title={`Remove ${row.operator_name || 'operator'} from ${line}`}
                                style={{
                                  background: 'transparent',
                                  border: '1px solid var(--border)',
                                  color: '#ff7070',
                                  cursor: 'pointer',
                                  borderRadius: 3,
                                  padding: '0 5px',
                                  fontSize: 12,
                                  lineHeight: '18px',
                                  height: 20,
                                  flexShrink: 0,
                                }}
                              >
                                ×
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })}
                  {(sections.Unassigned || []).length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 8px 10px' }}>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                        color: '#ff9d33', textTransform: 'uppercase', letterSpacing: '0.08em',
                      }}>
                        Unassigned ({sections.Unassigned.length})
                      </span>
                      <div style={{ marginTop: 6 }}>
                        {sections.Unassigned.map((row) => (
                          <div
                            key={row.id}
                            style={{
                              background: 'var(--surface2)',
                              border: '1px dashed #ff9d33',
                              borderRadius: 3,
                              padding: '5px 8px',
                              marginBottom: 4,
                              display: 'flex', alignItems: 'flex-start', gap: 6,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: 'var(--t1)' }}>{row.operator_name || '(unknown)'}</div>
                              <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                                Legacy row · re-drag to a section
                              </div>
                            </div>
                            <button
                              onClick={() => handleUnassign(row, line)}
                              title={`Remove ${row.operator_name || 'operator'} from ${line}`}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border)',
                                color: '#ff7070',
                                cursor: 'pointer',
                                borderRadius: 3,
                                padding: '0 5px',
                                fontSize: 12,
                                lineHeight: '18px',
                                height: 20,
                                flexShrink: 0,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PerformanceTab — per-operator point-event log + supervisor add modal.
// Worker getPerformanceHistory returns { total, events } pre-summed.
// addPerformanceEvent records points (non-zero int), reason, category,
// event_date; recorded_by is captured server-side from JWT userId.
// ═══════════════════════════════════════════════════════════════════════════
const PERFORMANCE_CATEGORIES = [
  { value: 'attendance', label: 'Attendance' },
  { value: 'quality',    label: 'Quality' },
  { value: 'behaviour',  label: 'Behaviour' },
  { value: 'output',     label: 'Output' },
  { value: 'other',      label: 'Other' },
];

function PerformanceTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [selectedOp, setSelectedOp] = useState(null);
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [data, setData] = useState({ total: 0, events: [] });
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const comboRef = useRef(null);

  const activeOperators = useMemo(
    () => (operators || []).filter((o) => o.status !== 'inactive'),
    [operators]
  );

  const filteredOps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeOperators;
    return activeOperators.filter((o) =>
      (o.name || '').toLowerCase().includes(q) ||
      (o.employee_id || '').toLowerCase().includes(q)
    );
  }, [activeOperators, query]);

  // Close dropdown on outside click + ESC
  useEffect(() => {
    if (!showDropdown) return;
    function onDocClick(e) {
      if (comboRef.current && !comboRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') setShowDropdown(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [showDropdown]);

  const operatorId = selectedOp?.id || '';

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !operatorId) {
      setData({ total: 0, events: [] });
      return;
    }
    setLoading(true);
    try {
      const res = await workerFetch(
        'getPerformanceHistory',
        { data: { operator_id: operatorId } },
        session
      );
      const inner = res?.data || {};
      setData({
        total: Number(inner.total) || 0,
        events: Array.isArray(inner.events) ? inner.events : [],
      });
    } catch (e) {
      showToast(e.message || 'Failed to load performance', 'error');
      setData({ total: 0, events: [] });
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, operatorId, showToast]);

  useEffect(() => { load(); }, [load]);

  function pickOperator(op) {
    setSelectedOp(op);
    setQuery(`${op.name} — ${op.employee_id}`);
    setShowDropdown(false);
  }

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Performance log is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  const totalColor = data.total > 0 ? 'var(--green)' : data.total < 0 ? '#ff7070' : 'var(--t2)';

  const columns = [
    { key: 'event_date',  label: 'Date' },
    { key: 'points',      label: 'Points' },
    { key: 'category',    label: 'Category' },
    { key: 'reason',      label: 'Reason' },
    { key: 'recorded_by', label: 'Recorded by' },
  ];

  function renderCell(row, c) {
    switch (c.key) {
      case 'event_date':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtDate(row.event_date)}</span>;
      case 'points': {
        const p = Number(row.points);
        const color = p > 0 ? 'var(--green)' : p < 0 ? '#ff7070' : 'var(--t2)';
        return <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color }}>{p > 0 ? `+${p}` : p}</span>;
      }
      case 'category': {
        const def = PERFORMANCE_CATEGORIES.find((x) => x.value === (row.category || 'other'));
        return def?.label || capitalize(row.category || 'other');
      }
      case 'reason': {
        const t = row.reason || '';
        return <span title={t.length > 80 ? t : undefined}>{t.length > 80 ? t.slice(0, 80) + '…' : t}</span>;
      }
      case 'recorded_by':
        return row.recorded_by_name || '—';
      default:
        return row[c.key];
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div ref={comboRef} style={{ flex: '1 1 280px', minWidth: 220, position: 'relative' }}>
            <span style={labelStyle}>Operator</span>
            <input
              type="text"
              value={query}
              placeholder="Search by name or employee ID…"
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedOp(null);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              onClick={() => setShowDropdown(true)}
              style={{ ...inputStyle, width: '100%' }}
            />
            {showDropdown && (
              <div
                style={{
                  position: 'absolute', top: '100%', left: 0, right: 0,
                  marginTop: 2, zIndex: 20,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  borderRadius: 3, maxHeight: 280, overflowY: 'auto',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                }}
              >
                {filteredOps.length === 0 ? (
                  <div style={{ padding: '8px 12px', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    No operators found
                  </div>
                ) : (
                  filteredOps.slice(0, 50).map((op) => {
                    const isSel = selectedOp?.id === op.id;
                    return (
                      <div
                        key={op.id}
                        onMouseDown={(e) => { e.preventDefault(); pickOperator(op); }}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          borderLeft: isSel ? '3px solid var(--yellow)' : '3px solid transparent',
                          background: isSel ? 'rgba(255,200,0,0.05)' : 'transparent',
                          fontSize: 12, color: 'var(--t1)',
                        }}
                        onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'var(--surface)'; }}
                        onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <div>{op.name}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                          {op.employee_id} · {capitalize(op.department || '')}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
          {operatorId && (
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center',
              padding: '6px 14px', background: 'var(--surface2)',
              border: '1px solid var(--border)', borderRadius: 3,
            }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color: totalColor }}>
                  {data.total > 0 ? `+${data.total}` : data.total} pts
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Events</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{data.events.length}</div>
              </div>
            </div>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add Event</button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {!operatorId ? (
            <EmptyState message="Select an operator to view their performance history" />
          ) : loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : data.events.length === 0 ? (
            <EmptyState message={`No performance events for ${selectedOp?.name || 'this operator'}`} />
          ) : (
            <DataTable
              columns={columns}
              rows={data.events}
              loading={false}
              emptyMessage=""
              renderCell={renderCell}
            />
          )}
        </div>
      </div>

      <AddPerformanceEventModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        session={session}
        operators={activeOperators}
        defaultOperatorId={operatorId}
        onSaved={(savedOpId, name) => {
          setShowAdd(false);
          showToast(`Performance event logged${name ? ' for ' + name : ''}`, 'success');
          if (operatorId && savedOpId === operatorId) load();
        }}
      />
    </div>
  );
}

function AddPerformanceEventModal({ open, onClose, session, operators, defaultOperatorId, onSaved }) {
  const { showToast } = useToast();
  const [opId, setOpId] = useState('');
  const [points, setPoints] = useState('');
  const [category, setCategory] = useState('quality');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(istToday());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setOpId(defaultOperatorId || '');
      setPoints('');
      setCategory('quality');
      setReason('');
      setDate(istToday());
      setSaving(false);
    }
  }, [open, defaultOperatorId]);

  async function save() {
    if (!opId) { showToast('Operator required', 'error'); return; }
    const p = Math.round(Number(points));
    if (!Number.isFinite(p) || p === 0) {
      showToast('Points must be a non-zero integer', 'error');
      return;
    }
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    if (!date)          { showToast('Date required', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch(
        'addPerformanceEvent',
        { data: { operator_id: opId, points: p, reason: reason.trim(), category, event_date: date } },
        session
      );
      const name = operators.find((o) => o.id === opId)?.name;
      onSaved?.(opId, name);
    } catch (e) {
      showToast(e.message || 'Insert failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log Performance Event"
      size="md"
      confirmLabel={saving ? 'Saving…' : 'Log Event'}
      onConfirm={save}
      loading={saving}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Field label="Operator *" full>
          <select value={opId} onChange={(e) => setOpId(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="">Select operator…</option>
            {operators.map((op) => (
              <option key={op.id} value={op.id}>{op.name} — {op.employee_id}</option>
            ))}
          </select>
        </Field>
        <Field label="Points *">
          <input
            type="number"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            placeholder="+5 or -3"
            style={{ ...inputStyle, width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
            Positive for good, negative for poor performance.
          </div>
        </Field>
        <Field label="Category *">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            {PERFORMANCE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Date *">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
        </Field>
        <Field label="Reason *" full>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What happened?"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    </Modal>
  );
}
