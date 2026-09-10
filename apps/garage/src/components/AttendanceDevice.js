'use client';
// ════════════════════════════════════════════════════════════════════
// AttendanceDevice — the gate phone panel.
//
// ⛔ ONE PLACE ONLY (Afshaan, 2026-09-10). This lived on Users & Roles → Scanner PINs while the
// phone fleet lived on Devices, so there were TWO doors to the same job — and they drifted:
// one got the 8-digit widening and the new copy, the other did not, which is what made
// "the enroll screen on Garage hasn't changed" true and confusing at the same time. It now
// renders inside the Phones surface and NOWHERE else. Do not re-add it to Users.
//
// Scope has not changed: exactly ONE phone is ever enrolled. A signing key is read on three
// actions (recordAttendance / recordBreak / getOperatorByCode) and only while
// store.settings.attendance_device_enforce='on'. Enrolling a station phone mints a key nothing
// will ever check.
// ════════════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from 'react';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };

/* ── Attendance device (S324) ─────────────────────────────────────────────────
   Afshaan's requirement, 2026-08-31: attendance must not be markable from an
   operator's own phone — "they'll get paid for it". Everything else in the
   scanner is explicitly NOT treated as a security issue, so this is deliberately
   ONE device and the four attendance handlers, not the 43-device fleet rollout
   the S319 design describes.

   Why a key and not a code: a code is a string in the phone's storage — screenshot
   it or read it out and anyone marks attendance from home. That is the
   department-PIN failure mode. The device generates a key the browser refuses to
   export, so possession of the physical phone IS the credential.

   ⚠️ NOTHING IS ENFORCED YET and this panel says so on screen. Enrol the gate
   phone, confirm it signs, and only then flip the handlers — every attendance call
   today carries no device code at all, so enforcing first stops 100% of clock-ins.
   ────────────────────────────────────────────────────────────────────────────── */
// ⚠️ NO `session` PROP. `useAuth`'s session object changes identity on a real token refresh
// (~hourly) and workerFetch does not self-heal a stale token, so the token is read inside each
// callback via getValidSession() — the same rule the Devices page around it follows.
export default function AttendanceDevice({ showToast }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel]         = useState('');
  const [reason, setReason]   = useState('');
  const [busy, setBusy]       = useState('');
  const [code, setCode]       = useState(null);   // { code, device_code, expires_at }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getValidSession();
      const rows = await garageFetch('getDevices', {}, s);
      setDevices(Array.isArray(rows) ? rows : []);
    } catch (e) { showToast(e.message || 'Failed to load devices', 'error'); }
    finally { setLoading(false); }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const current  = devices.find(d => d.is_attendance_device) || null;
  const enrolled = devices.filter(d => d.device_pubkey).length;

  // Act on an explicit device_code — used by mint/reset, which must always target the gate
  // phone regardless of what is selected in the dropdown.
  async function runOn(deviceCode, action, label) {
    if (!deviceCode) { showToast('No attendance device is set yet', 'error'); return; }
    return doRun(deviceCode, action, label);
  }

  async function run(action, label) {
    if (!sel) { showToast('Pick a device first', 'error'); return; }
    return doRun(sel, action, label);
  }

  async function doRun(deviceCode, action, label) {
    if (!reason.trim()) { showToast('A reason is required — it is logged', 'error'); return; }
    setBusy(action);
    try {
      const s = await getValidSession();
      const res = await workerFetch(action, { data: { device_code: deviceCode, reason: reason.trim() } }, s);
      const d = res?.data || {};
      // Mint actions return a one-time code; it is the only time it is shown.
      if (d.code) setCode({ code: d.code, device_code: d.device_code, expires_at: d.expires_at });
      showToast(d.warning || `${label} — done`, d.warning ? 'info' : 'success');
      setReason('');
      load();
    } catch (e) { showToast(e.message || `${label} failed`, 'error'); }
    finally { setBusy(''); }
  }

  const fmtWhen = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}><span>Attendance device</span></div>
      <div style={panelBodyStyle}>
        <p style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
          Locks clock-in/out to a single phone at the gate, so attendance cannot be marked from an
          operator&apos;s own device. The phone generates a key it cannot export — copying its settings
          gets you nothing. <strong style={{ color: 'var(--yellow)' }}>Not enforced yet:</strong> enrol the
          gate phone and confirm it signs before the lock is switched on, or every clock-in fails.
        </p>
        {/* ⛔ THIS LINE EXISTS BECAUSE THE PANEL READ AS A FLEET-WIDE TASK (Afshaan, 2026-09-10:
            "I do not understand why we need to continue to enroll"). The old counter said
            "1 of 76 devices enrolled", which invites you to enrol the other 75. A signing key is
            read on THREE actions only — recordAttendance / recordBreak / getOperatorByCode — so
            enrolling a station phone mints a key nothing ever checks. Do not soften this back. */}
        <p style={{ color: 'var(--t2)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: -6, marginBottom: 14, lineHeight: 1.55 }}>
          <strong>Exactly one phone is ever enrolled — this one.</strong> Floor scanners need no
          pairing and no code: install the app, then department PIN → station → line on the phone
          itself. Manage the rest of the fleet under <strong>Phones</strong>.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>CURRENT</span>
          {current
            ? <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>
                {current.device_code}
                {current.device_pubkey
                  ? <span style={{ color: 'var(--state-success-fg)' }}> · enrolled {fmtWhen(current.enrolled_at)}</span>
                  : <span style={{ color: 'var(--red)' }}> · NOT enrolled — it cannot sign</span>}
              </span>
            : <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>none set</span>}
          {/* NOT "{enrolled} of {devices.length} devices enrolled" — that framing is what made
              the floor start pairing ~50 phones for no reason. 76 is the register size, not a
              target. */}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            {/* Keyed on the GATE phone, not on "exactly one key exists" — those coincide today
                and would diverge the moment any other device held a key. */}
            {current?.device_pubkey ? 'gate phone enrolled' : 'gate phone NOT enrolled'}
            {enrolled > 1 ? ` · ${enrolled} phones hold a key` : ''}
            {' · '}{devices.length} phones in the register
          </span>
        </div>

        {code && (
          <div style={{ border: '1px solid rgba(214,168,42,.45)', borderRadius: 4, padding: '10px 12px', marginBottom: 14, background: 'rgba(214,168,42,.06)' }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>
              ENROLMENT CODE for {code.device_code} — type it on that phone. Shown once, single use, expires {fmtWhen(code.expires_at)}.
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--yellow)' }}>{code.code}</div>
          </div>
        )}

        {loading ? <Spinner /> : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...inputStyle, minWidth: 230 }}>
              <option value="">Select a device…</option>
              {devices.filter(d => d.is_active !== false).map(d => (
                <option key={d.device_code} value={d.device_code}>
                  {d.device_code}{d.device_pubkey ? ' · enrolled' : ''}{d.is_attendance_device ? ' · ATTENDANCE' : ''}
                </option>
              ))}
            </select>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (logged)"
              style={{ ...inputStyle, minWidth: 220, flex: 1 }} />
            {/* ⛔ MINT AND RESET ACT ON THE GATE PHONE, NOT ON THE DROPDOWN (S371 second review,
                finding 9). The dropdown exists for "Make attendance device" — choosing which
                handset the gate is. Wiring mint to it re-opened the exact hole this session
                closed on the Devices grid: minting a key for a station phone, which nothing
                will ever check. Disabled until an attendance device exists. */}
            <button type="button" disabled={!!busy || !current} onClick={() => runOn(current?.device_code, 'createDeviceEnrolment', 'Enrolment code minted')}
              style={{ ...inputStyle, cursor: 'pointer', color: 'var(--t1)' }}>
              {busy === 'createDeviceEnrolment' ? '…' : (current ? `Mint code for ${current.device_code}` : 'No attendance device set')}
            </button>
            <button type="button" disabled={!!busy} onClick={() => run('setAttendanceDevice', 'Attendance device set')}
              style={{ ...inputStyle, cursor: 'pointer', color: 'var(--yellow)', borderColor: 'rgba(214,168,42,.45)' }}>
              {busy === 'setAttendanceDevice' ? '…' : 'Make attendance device'}
            </button>
            <button type="button" disabled={!!busy || !current} onClick={() => runOn(current?.device_code, 'resetDeviceEnrolment', 'Enrolment reset')}
              title="Clears the device's key and mints a fresh code — use when a phone is lost, wiped or replaced"
              style={{ ...inputStyle, cursor: 'pointer', color: '#ff7070', borderColor: 'rgba(222,42,42,.3)' }}>
              {busy === 'resetDeviceEnrolment' ? '…' : 'Reset enrolment'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
