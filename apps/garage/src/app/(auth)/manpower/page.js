'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Modal, ConfirmModal, Badge, DataTable, EmptyState } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

// ── Legacy daily-log activity presets (preserved from prior page) ───────────
const MP_ACTIVITIES = [
  { key: 'inwarding',   label: 'Inwarding / Receiving / GRN', color: 'var(--green)'  },
  { key: 'issuance',    label: 'Issuance / Picking',          color: 'var(--yellow)' },
  { key: 'counting',    label: 'Counting / Audit',            color: 'var(--blue)'   },
  { key: 'bagging',     label: 'Bagging & Tagging',           color: 'var(--blue)'   },
  { key: 'rearranging', label: 'Rearranging / Organising',    color: 'var(--t2)'     },
  { key: 'cleanup',     label: 'Clean-up',                    color: 'var(--t3)'     },
  { key: 'qa',          label: 'QA / Inspection',             color: '#a78bfa'       },
  { key: 'dispatch',    label: 'Dispatch / Packing',          color: 'var(--t2)'     },
  { key: 'other',       label: 'Other',                       color: 'var(--t3)'     },
];
const SHIFT_COLORS = { Morning: 'var(--yellow)', Afternoon: 'var(--blue)', Night: 'var(--t3)' };

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
  const [activeTab, setActiveTab] = useState('operators');

  // canManageFloor mirrors worker.js's canManageFloor predicate.
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

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
      {activeTab === 'attendance'  && <AttendanceTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'roster'      && <DailyRosterTab session={session} />}
      {activeTab === 'performance' && <ComingSoon label="Performance — points and events (Step 6D)" />}
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

function ComingSoon({ label }) {
  return (
    <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>{label} — coming soon</div>
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

  const columns = [
    { key: 'employee_id',     label: 'Employee ID' },
    { key: 'name',            label: 'Name' },
    { key: 'department',      label: 'Department' },
    { key: 'employment_type', label: 'Type' },
    { key: 'status',          label: 'Status' },
    { key: 'phone',           label: 'Phone' },
    { key: 'join_date',       label: 'Join Date' },
    ...(canManageFloor ? [{ key: '_actions', label: '' }] : []),
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
          <button
            onClick={(e) => { e.stopPropagation(); setEditTarget(row); }}
            style={{ ...btnSecondary, padding: '4px 8px' }}
            title="Edit"
          >
            ✎ Edit
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
    if (!name.trim())  { showToast('Name required', 'error'); return; }
    if (!department)   { showToast('Department required', 'error'); return; }
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
        <Field label="Employment Type">
          <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="in_house">In House</option>
            <option value="contract">Contract</option>
          </select>
        </Field>
        <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Join Date"><input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Date of Birth"><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
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

function AttendanceTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closing, setClosing] = useState(false);

  const opMap = useMemo(() => {
    const m = {};
    for (const op of operators) m[op.id] = op;
    return m;
  }, [operators]);

  // Load operators once (for employee_id lookup — worker attendance rows don't carry it)
  useEffect(() => {
    if (!session || !canManageFloor) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await workerFetch('getOperators', { data: { status: '' } }, session);
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setOperators(list);
      } catch (e) {
        if (!cancelled) showToast(e.message || 'Failed to load operators', 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [session, canManageFloor, showToast]);

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
// DailyRosterTab — preserves the legacy daily headcount log + history.
// Uses the legacy `manpower_log` schema via garageFetch/getManpower and
// workerFetch/postManpower. A future task will rewrite this against the new
// store.manpower_assignments table.
// ═══════════════════════════════════════════════════════════════════════════
function freshActivityRows() {
  return MP_ACTIVITIES.map((a, i) => ({ id: i + 1, preset: a.key, custom: '', count: '' }));
}

function DailyRosterTab({ session }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(todayStr());
  const [shift, setShift] = useState('Morning');
  const [notes, setNotes] = useState('');
  const [activityRows, setActivityRows] = useState(freshActivityRows());
  const [submitting, setSubmitting] = useState(false);
  const [days, setDays] = useState(7);
  const [logs, setLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setHistoryLoading(true);
    try {
      const data = await garageFetch('getManpower', { days }, session);
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load manpower history', 'error');
      setLogs([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [session, days, showToast]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const totalHeadcount = useMemo(
    () => activityRows.reduce((s, r) => s + (parseInt(r.count) || 0), 0),
    [activityRows]
  );

  function updateRow(id, field, value) {
    setActivityRows((rows) => rows.map((r) => r.id === id ? { ...r, [field]: value } : r));
  }
  function addRow() {
    setActivityRows((rows) => [...rows, { id: Date.now(), preset: '', custom: '', count: '' }]);
  }
  function removeRow(id) {
    setActivityRows((rows) => rows.filter((r) => r.id !== id));
  }

  async function handleSubmit() {
    const finalActivities = [];
    activityRows.forEach((row) => {
      const count = parseInt(row.count) || 0;
      if (count === 0) return;
      const actKey = row.preset || '';
      const actLabel = actKey
        ? (MP_ACTIVITIES.find((a) => a.key === actKey)?.label || actKey)
        : (row.custom?.trim() || 'Other');
      finalActivities.push({
        person_name: String(count) + 'x',
        activity:    actLabel,
        station:     actKey || null,
      });
    });
    if (totalHeadcount === 0) {
      showToast('Enter at least one activity with headcount > 0', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('postManpower', {
        data: {
          log_date:   date,
          shift,
          headcount:  totalHeadcount,
          notes:      notes || null,
          activities: finalActivities,
        },
      }, session);
      const result = res.data || res;
      showToast(`Manpower logged — ${result.headcount || totalHeadcount} staff on ${shift} shift`, 'success');
      setNotes('');
      setActivityRows(freshActivityRows());
      loadHistory();
    } catch (e) {
      showToast(e.message || 'Failed to log manpower', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const maxCount = Math.max(...logs.map((l) => l.headcount || 0), 1);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      {/* LOG FORM */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Log Manpower</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
              disabled={submitting}
            />
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value)}
              style={selectStyle}
              disabled={submitting}
            >
              <option>Morning</option>
              <option>Afternoon</option>
              <option>Night</option>
            </select>
          </div>
        </div>
        <div style={panelBodyStyle}>
          <div style={{ marginBottom: 8, fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Activity Breakdown</div>
          {activityRows.map((row) => {
            const isCustom = !row.preset;
            return (
              <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <div style={{ display: 'grid', gridTemplateColumns: isCustom ? '1fr 1fr' : '1fr', gap: 6 }}>
                  <select
                    value={row.preset}
                    onChange={(e) => updateRow(row.id, 'preset', e.target.value)}
                    style={selectStyle}
                    disabled={submitting}
                  >
                    <option value="">Custom activity…</option>
                    {MP_ACTIVITIES.map((a) => (
                      <option key={a.key} value={a.key}>{a.label}</option>
                    ))}
                  </select>
                  {isCustom && (
                    <input
                      type="text"
                      placeholder="Activity name"
                      value={row.custom}
                      onChange={(e) => updateRow(row.id, 'custom', e.target.value)}
                      style={inputStyle}
                      disabled={submitting}
                    />
                  )}
                </div>
                <input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={row.count}
                  onChange={(e) => updateRow(row.id, 'count', e.target.value)}
                  style={{ ...inputStyle, fontSize: 13, fontWeight: 700, textAlign: 'center', fontFamily: 'var(--mono)' }}
                  disabled={submitting}
                />
                <button
                  onClick={() => removeRow(row.id)}
                  disabled={submitting}
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: 0, height: 28 }}
                  title="Remove row"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            onClick={addRow}
            disabled={submitting}
            style={{ ...btnSecondary, marginTop: 4 }}
          >
            + Add Activity
          </button>

          <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Headcount</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 700, color: 'var(--yellow)' }}>{totalHeadcount}</span>
          </div>

          <div style={{ marginTop: 12 }}>
            <span style={labelStyle}>Notes (optional)</span>
            <input
              type="text"
              placeholder="Optional notes…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
              disabled={submitting}
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ ...btnPrimary, width: '100%', marginTop: 14, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
          >
            {submitting ? 'SAVING…' : 'SAVE LOG'}
          </button>
        </div>
      </div>

      {/* HISTORY */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>History</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              style={selectStyle}
              disabled={historyLoading}
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
            </select>
            <button style={btnSecondary} onClick={loadHistory} disabled={historyLoading}>↻</button>
          </div>
        </div>
        <div style={panelBodyStyle}>
          {historyLoading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : logs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No manpower logs yet</div>
          ) : (
            logs.map((l) => {
              const pct = ((l.headcount || 0) / maxCount) * 100;
              const sc = SHIFT_COLORS[l.shift] || 'var(--t2)';
              const acts = Array.isArray(l.activities) ? l.activities : [];
              return (
                <div key={l.id} style={{ borderBottom: '1px solid var(--border)', padding: '12px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13 }}>{l.log_date}</span>
                      <span style={{ fontSize: 11, color: sc, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{l.shift}</span>
                      {l.notes && <span style={{ fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>{l.notes}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ width: 80, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--yellow)' }} />
                      </div>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>{l.headcount || 0}</span>
                      <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>staff</span>
                    </div>
                  </div>
                  {acts.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                      {acts.map((a) => {
                        const def = MP_ACTIVITIES.find((x) => x.key === a.station);
                        const color = def?.color || 'var(--t2)';
                        const count = parseInt(a.person_name) || 0;
                        return (
                          <div key={a.id || `${a.activity}-${a.station}-${a.person_name}`} style={{ background: 'var(--surface2)', borderLeft: `3px solid ${color}`, padding: '6px 10px', borderRadius: 2 }}>
                            <div style={{ fontSize: 11, color: 'var(--t2)' }}>{a.activity}</div>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color }}>{count}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
