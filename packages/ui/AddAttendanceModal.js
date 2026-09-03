'use client';
import { useMemo, useState } from 'react';
import { Modal } from './Modal.js';
import { Combobox } from './Combobox.js';
import { useToast } from './Toast.js';

/**
 * AddAttendanceModal — the supervisor "manually add attendance" form.
 *
 * The scanner refuses a punch outside every shift window (`no_open_window`), so that
 * operator's day never becomes a row at all; this form is the only path that creates one.
 * It is payroll input (RULE-COST-001) — the worker's `addAttendanceRow` re-checks the
 * `attendance_manage` permission, so the caller's gate is UX, never the control.
 *
 * ⚠️ SHARED ON PURPOSE. Three apps own an attendance surface — Redline (production),
 * Depot (dispatch) and Garage (store) — and their AttendanceTabs have already diverged in
 * chrome. A payroll-WRITE form maintained in triplicate would drift, so the form, its
 * validation and the 7-day backdate window live here once. Presentational only: the caller
 * passes `onSubmit`, which is where workerFetch lives, keeping this package free of any
 * @throttle/db import (it has none today and should keep none).
 *
 * Props:
 *   operators   — raw operator records [{ id, name, employee_id, department, team, status }].
 *                 Inactive ones are filtered out here; the worker rejects them anyway.
 *   team        — optional: scope the picker to one team ('dispatch' / 'store').
 *   defaultDate — the day the caller's list is showing; used when inside the window.
 *   onSubmit    — async ({ operator_id, date, clock_in, clock_out?, note? }) => worker data.
 *                 MUST throw on failure with the worker's message on `e.message`.
 *   onSaved     — ({ ...workerData, date }) => void. Close + refresh; the toast is ours.
 *   onClose     — dismiss.
 */
const BACKDATE_DAYS = 7;   // matches the worker's window — keep the two in step

function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function minusDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const fieldLabel = {
  display: 'block', marginBottom: 6, fontSize: 9, letterSpacing: '.08em',
  textTransform: 'uppercase', color: 'var(--t3)', fontFamily: 'var(--mono)',
};
const fieldInput = {
  width: '100%', background: 'var(--surface2, #1a1a1a)', border: '1px solid var(--border, #333)',
  borderRadius: 3, padding: '8px 11px', fontSize: 13, color: 'var(--t1, #eee)',
  outline: 'none', fontFamily: 'inherit',
};

function Field({ label, children }) {
  return (
    <div>
      <span style={fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

export function AddAttendanceModal({ operators, team, defaultDate, onSubmit, onSaved, onClose }) {
  const { showToast } = useToast();
  const today   = istToday();
  const minDate = useMemo(() => minusDays(today, BACKDATE_DAYS), [today]);

  const [opId, setOpId]         = useState('');
  // Default to the day the caller is viewing when it is inside the window, else today.
  const [date, setDate]         = useState(defaultDate >= minDate && defaultDate <= today ? defaultDate : today);
  const [clockIn, setClockIn]   = useState('');
  const [clockOut, setClockOut] = useState('');
  const [note, setNote]         = useState('');
  const [saving, setSaving]     = useState(false);

  const opOptions = useMemo(
    () => (operators || [])
      .filter((op) => (op.status || 'active') === 'active')
      .filter((op) => !team || (op.team || '') === team)
      .map((op) => ({
        value: op.id,
        label: op.name,
        hint: [op.employee_id, op.department].filter(Boolean).join(' · '),
      })),
    [operators, team]
  );

  async function save() {
    if (!opId)    { showToast('Pick an operator', 'error'); return; }
    if (!date)    { showToast('Pick a date', 'error'); return; }
    if (!clockIn) { showToast('Clock in is required', 'error'); return; }
    // ⚠️ Deliberately NOT rejecting clockOut <= clockIn here. Only the worker knows the
    // operator's shift, and an `ends_next_day` shift (assembly 3rd Shift, 23:00 → 06:00)
    // clocks out at an earlier wall-clock time by definition. The worker refuses it with
    // the same words on every other shift, and that message is surfaced verbatim below.
    setSaving(true);
    try {
      const d = (await onSubmit({
        operator_id: opId,
        date,
        clock_in: clockIn,
        ...(clockOut ? { clock_out: clockOut } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })) || {};
      showToast(
        d.shift_matched === false
          ? `Attendance added for ${d.operator_name || 'operator'} — no shift matched, hours recorded without a schedule`
          : `Attendance added for ${d.operator_name || 'operator'}`,
        'success'
      );
      onSaved?.({ ...d, date });
    } catch (e) {
      // The worker's own words — "already has an attendance row for …" and the backdate
      // ceiling are the two a supervisor will actually hit, and both are actionable.
      showToast(e.message || 'Failed to add attendance', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add attendance"
      confirmLabel={saving ? 'Adding…' : 'Add attendance'} onConfirm={save} loading={saving}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Operator *">
          {/* portal: this renders over a card/table context an absolute dropdown gets clipped by. */}
          <Combobox
            value={opId}
            options={opOptions}
            onChange={(v) => setOpId(v)}
            placeholder="Search name or employee ID…"
            portal
            autoFocus
          />
        </Field>
        <Field label="Date *">
          <input type="date" value={date} min={minDate} max={today}
            onChange={(e) => setDate(e.target.value)} style={fieldInput} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Clock in *">
            <input type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} style={fieldInput} />
          </Field>
          <Field label="Clock out (optional)">
            <input type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} style={fieldInput} />
          </Field>
        </div>
        <Field label="Note (optional — why it was added by hand)">
          <input value={note} onChange={(e) => setNote(e.target.value)} style={fieldInput}
            placeholder="e.g. badge left at home, gate log verified" />
        </Field>
        <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>
          Times are IST. Backdating is limited to {BACKDATE_DAYS} days. Leaving clock-out empty
          creates an open shift, closable from this tab like any other.
        </div>
      </div>
    </Modal>
  );
}
