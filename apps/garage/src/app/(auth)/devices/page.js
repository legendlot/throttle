'use client';
// ════════════════════════════════════════════════════════════════════
// Devices — the ONE screen for the scanner phone fleet.
//
// Afshaan, 2026-09-10: "a clean interface on Garage admin where I can manage these phones and
// not ask floor every few mins to go and enroll the phone." Rename · station + lock · disable
// and re-enable scanning · pair a phone · and a census that says whether we are losing or
// gaining handsets. It grew out of the read-only Device Register (S345).
//
// ⚠️ THIS IS NO LONGER OBSERVE-ONLY. Setting a handset to BLOCKED now genuinely refuses every
// scanner action (S369, lib/device-fleet.js). The old copy on this page said the opposite and
// was stale the day the enforcement shipped — do not reinstate it.
//
// TWO LISTS, TWO DIFFERENT THINGS, and they must never be added together:
//   • Phones      = public.devices — the REGISTER. A station slot: its code, station, lock,
//                   signing key. This is what a scan authenticates as.
//   • Handsets    = public.device_hw — the HARDWARE actually reporting in via X-LOT-HW, which
//                   ONLY the LOT Scanner APK sends. A phone using the website is simply absent.
// They are matched on `device_hw.claimed_device_code`, which is CLIENT-SUPPLIED and proves
// nothing on its own; hw_id is an identifier, not a credential.
//
// ⚠️ super_admin only, in the worker (getDeviceFleet / setDeviceStation / getDevices /
// createDeviceEnrolment) and in nav.js. `setDeviceHw`/`setDeviceHwSetting` are the exception:
// they stay on users_manage because cs_lead and gate_ops hold it and tightening them would
// take the register away from 2 live users (measured against store.roles 2026-09-10).
//
// FOLLOW-UP, deliberately not done here: the Users page still carries its own "Attendance
// device" panel (getDevices / createDeviceEnrolment / setAttendanceDevice / resetDeviceEnrolment).
// It is left working on purpose; folding it in and deleting it is a separate task.
// ════════════════════════════════════════════════════════════════════
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Smartphone, RefreshCw, Search, Lock, Unlock, KeyRound, ShieldAlert } from 'lucide-react';

const STATUSES = ['unknown', 'known', 'blocked'];

const STATUS_STYLE = {
  known:   { bg: 'rgba(34,197,94,.12)',  fg: '#22c55e', label: 'Scanning allowed' },
  unknown: { bg: 'rgba(242,205,26,.12)', fg: '#F2CD1A', label: 'Not identified' },
  blocked: { bg: 'rgba(222,42,42,.12)',  fg: '#DE2A2A', label: 'BLOCKED — cannot scan' },
};

const BORDER = '1px solid var(--border,#404040)';

function ago(ts) {
  if (!ts) return 'never';
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

const inputCss = {
  padding: '6px 9px', borderRadius: 6, border: BORDER,
  background: 'transparent', color: 'inherit', fontSize: 13, minWidth: 0,
};

const btnCss = {
  padding: '6px 12px', borderRadius: 6, cursor: 'pointer', border: BORDER,
  background: 'transparent', color: 'inherit', fontSize: 12, fontWeight: 700,
};

// ── The pairing code panel ──────────────────────────────────────────────────
// This is the flow the floor uses OVER THE PHONE — someone reads the six digits out loud from
// across the room. Hence the size and the live countdown: a code that has silently expired
// while it sits on screen is the failure this is built to prevent.
function PairCode({ pair, onDone }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!pair?.expires_at) return undefined;
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(pair.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pair]);
  if (!pair) return null;
  const dead = left <= 0;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div style={{ border: `2px solid ${dead ? 'rgba(222,42,42,.5)' : 'rgba(242,205,26,.55)'}`,
                  borderRadius: 12, padding: '16px 18px', marginBottom: 18,
                  background: dead ? 'rgba(222,42,42,.06)' : 'rgba(242,205,26,.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Pairing code for {pair.device_code}</strong>
        <button onClick={onDone} style={{ ...btnCss, marginLeft: 'auto' }}>Done</button>
      </div>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800,
                    fontSize: 'clamp(44px, 14vw, 84px)', letterSpacing: '.14em', lineHeight: 1.1,
                    color: dead ? '#DE2A2A' : '#F2CD1A' }}>
        {pair.code}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, opacity: .85 }}>
        {dead
          ? <span style={{ color: '#DE2A2A', fontWeight: 700 }}>EXPIRED — mint a new one.</span>
          : <>Read it out to whoever is holding the phone. Type it into the Scanner app on
             that handset. Single use. <strong>Expires in {mm}:{ss}</strong> ({istStamp(pair.expires_at)} IST).</>}
      </div>
    </div>
  );
}

export default function DevicesPage() {
  // ⚠️ Key loads on userId, NEVER on the session object: onAuthStateChange re-fires on tab
  // switch and a real token refresh lands ~hourly, and this page holds unsaved edits.
  // ⚠️ And do NOT close over `session` either — workerFetch does not self-heal a stale token,
  // so the token is read inside each callback via getValidSession().
  const { userId, role } = useAuth();
  const toast = useToast();

  const [devices, setDevices] = useState([]);
  const [hw, setHw]           = useState([]);
  const [bindings, setBind]   = useState([]);
  const [census, setCensus]   = useState(null);
  const [caps, setCaps]       = useState(null);
  const [settings, setSet]    = useState({});
  const [dryRun, setDryRun]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [firstDone, setFirstDone] = useState(false);
  const [q, setQ]             = useState('');
  const [busyId, setBusy]     = useState(null);
  const [drafts, setDrafts]   = useState({});   // device_code -> { label, station, line }
  const [hwDrafts, setHwD]    = useState({});   // hw_id -> label being typed
  const [pair, setPair]       = useState(null); // { code, device_code, expires_at }
  const pairRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getValidSession();
      // ONE call for the register, the hardware, the bindings and the census. The second call
      // is only for the two display-only toggles' dry run, which getDeviceHw owns.
      // ⛔ `getDeviceFleet` IS A **GET** HANDLER — it lives in worker.js's `switch (action)`
      // (the URL `?action=` router), NOT the POST `switch (body.action)` one. So it MUST go
      // through `garageFetch`. Calling it with `workerFetch` fell through the POST switch to
      // "Unknown action" and came back 400, which rendered as an EMPTY register — "Phones (0)"
      // on a floor with 67 device rows. Caught by the browser smoke, not by any build or test:
      // both helpers type-check identically and the page still rendered.
      // ⚠️ THE TWO HELPERS HAVE DIFFERENT CONTRACTS, so this is not a one-word swap:
      //   garageFetch → GET, **unwraps to `body.data`** and **THROWS** on a non-2xx
      //   workerFetch → POST, returns the RAW envelope `{ ok, data, error }`
      // Hence no `.ok` test on the fleet (a failure lands in the catch below), and `getDeviceHw`
      // keeps its envelope check unchanged — it is genuinely a POST handler.
      const [fleet, hwR] = await Promise.all([
        garageFetch('getDeviceFleet', {}, s),
        workerFetch('getDeviceHw', {}, s),
      ]);
      setDevices(fleet?.devices || []);
      setHw(fleet?.hw || []);
      setBind(fleet?.bindings || []);
      setCensus(fleet?.census || null);
      setCaps(fleet?.caps || null);
      setSet(fleet?.settings || {});
      // ⚠️ getDeviceHw is users_manage, getDeviceFleet is super_admin — so this one can
      // succeed while the other 403s, and never the reverse. A missing dry run only costs the
      // two flag counts, so it is not treated as an error.
      if (hwR?.ok) setDryRun(hwR.data?.dryRun || null);
    } catch (e) {
      toast?.error?.('Could not load the fleet: ' + e.message);
    } finally {
      setLoading(false);
      setFirstDone(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => { if (userId) load(); }, [userId, load]);

  // hw rows keyed by the station code they claim, and by hw_id.
  const hwByCode = useMemo(() => {
    const m = {};
    for (const h of hw) if (h.claimed_device_code) m[h.claimed_device_code] = h;
    return m;
  }, [hw]);

  const codesByHw = useMemo(() => {
    const m = {};
    for (const b of bindings) (m[b.hw_id] ||= []).push(b);
    return m;
  }, [bindings]);

  // ── Writes ────────────────────────────────────────────────────────────────
  // ⚠️ workerFetch flattens its body as {action, ...body} and every handler reads body.data —
  // so the payload MUST be wrapped. Flat yields "device_code required" from a call that looks
  // perfectly correct at this end.
  const saveDevice = async (device_code, patch) => {
    setBusy(device_code);
    try {
      const s = await getValidSession();
      const r = await workerFetch('setDeviceStation', { data: { device_code, ...patch } }, s);
      if (!r?.ok) { toast?.error?.(r?.error || 'Update failed'); return; }
      setDevices(ds => ds.map(x => (x.device_code === device_code ? { ...x, ...patch } : x)));
      setDrafts(d => { const n = { ...d }; delete n[device_code]; return n; });
      toast?.success?.(r.data?.warning || 'Saved');
    } catch (e) {
      toast?.error?.('Update failed: ' + e.message);
    } finally { setBusy(null); }
  };

  const saveHw = async (hw_id, patch) => {
    setBusy(hw_id);
    try {
      const s = await getValidSession();
      const r = await workerFetch('setDeviceHw', { data: { hw_id, ...patch } }, s);
      if (!r?.ok) { toast?.error?.(r?.error || 'Update failed'); return; }
      setHw(hs => hs.map(x => (x.hw_id === hw_id ? { ...x, ...patch } : x)));
      setHwD(d => { const n = { ...d }; delete n[hw_id]; return n; });
      toast?.success?.(patch.status === 'blocked'
        ? 'Blocked — this handset can no longer scan (within 30s)'
        : 'Saved');
    } catch (e) {
      toast?.error?.('Update failed: ' + e.message);
    } finally { setBusy(null); }
  };

  const flipSetting = async (key, next) => {
    try {
      const s = await getValidSession();
      const r = await workerFetch('setDeviceHwSetting', { data: { key, value: next } }, s);
      if (!r?.ok) { toast?.error?.(r?.error || 'Could not change setting'); return; }
      setSet(cur => ({ ...cur, [key]: { ...(cur[key] || { key }), value: next } }));
      toast?.success?.(`${key} → ${next}`);
    } catch (e) { toast?.error?.('Could not change setting: ' + e.message); }
  };

  const mintPair = async (device_code) => {
    setBusy(device_code);
    try {
      const s = await getValidSession();
      const r = await workerFetch('createDeviceEnrolment',
        { data: { device_code, reason: 'Paired from the Devices console' } }, s);
      if (!r?.ok) { toast?.error?.(r?.error || 'Could not mint a code'); return; }
      setPair({ code: r.data.code, device_code: r.data.device_code, expires_at: r.data.expires_at });
      pairRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast?.error?.('Could not mint a code: ' + e.message);
    } finally { setBusy(null); }
  };

  // ── Filtering ─────────────────────────────────────────────────────────────
  const needle = q.trim().toLowerCase();
  const match = (...vals) => !needle || vals.some(v => String(v || '').toLowerCase().includes(needle));

  const shownDevices = useMemo(() => devices.filter(d => {
    const h = hwByCode[d.device_code];
    return match(d.device_code, d.label, d.station, d.line, h?.hw_id, h?.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [devices, hwByCode, needle]);

  // Handsets reporting hardware that no register row claims — "new arrivals". They cannot be
  // given a station here: a station code is a row in public.devices, not a label on a handset.
  const orphanHw = useMemo(() => hw.filter(h =>
    (!h.claimed_device_code || !devices.some(d => d.device_code === h.claimed_device_code)) &&
    match(h.hw_id, h.label, h.last_station)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [hw, devices, needle]);

  // ⚠️ INVERTED POLARITY, and this is the one place on the page where "missing" does NOT mean
  // "off". `device_block_enforce` absent/unreadable = ENFORCING; only the literal 'off' lifts
  // every hardware block at once. Rendering an absent row as "off" would tell an admin the
  // fleet is unprotected when it is not. See lib/device-fleet.js.
  const blockEnforcing = String(settings.device_block_enforce?.value || '').toLowerCase() !== 'off';

  const TOGGLES = [
    { key: 'device_hw_roam_alert', title: 'Flag roaming handsets',
      body: 'A handset used as more than one station code. Roaming is allowed — this measures how often it actually happens before any rule is set.',
      would: dryRun?.roaming_devices },
    { key: 'device_hw_unbound_flag', title: 'Flag unbound handsets',
      body: 'A handset that has never claimed a station code. Attendance and Lookup send none, so unbound does NOT mean unrecognised.',
      would: dryRun?.unbound_devices },
  ];

  const CENSUS = census ? [
    { label: 'Phones registered', v: census.devices_active,   hint: 'Active rows in the device register' },
    { label: 'Scanned today',     v: census.seen_today,       hint: 'Reported in since midnight IST', good: true },
    { label: 'Quiet 3+ days',     v: census.stale_3d,         hint: 'Active but not seen for 3 days, or never seen', warn: true },
    { label: 'Running the app',   v: census.hw_total,         hint: 'Handsets sending a hardware ID. A phone on the website is absent.' },
    { label: 'New handsets (7d)', v: census.hw_new_7d,        hint: 'First reported in the last week — arrivals', good: true },
    { label: 'Unclaimed',         v: census.hw_unclaimed,     hint: 'Reporting hardware but no station code claimed yet' },
    { label: 'Blocked',           v: census.hw_blocked,       hint: 'Refused on every scanner action', warn: true },
    { label: 'Paired (has key)',  v: census.devices_with_key, hint: 'Holds a signing key from enrolment' },
  ] : [];

  // ⚠️ A spinner must never replace a surface holding unsaved input — this page holds label
  // and station drafts, so only the FIRST load is allowed to take over the screen.
  if (loading && !firstDone) return <Spinner />;

  // Non-super_admins never see the nav item, but a bookmarked URL still lands here and every
  // call would 403 with no explanation. Say so instead.
  if (role && role !== 'super_admin') {
    return (
      <div style={{ padding: 24, maxWidth: 620, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>Devices</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, opacity: .85 }}>
          Managing scanner phones is restricted to super admins — blocking a handset stops it
          scanning on the floor. Ask Afshaan if you need a phone renamed, moved or paired.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px clamp(12px,3vw,24px) 40px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <Smartphone size={22} />
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Devices</h1>
        <button onClick={load} disabled={loading}
          style={{ ...btnCss, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
                   opacity: loading ? .6 : 1 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div ref={pairRef} />
      <PairCode pair={pair} onDone={() => { setPair(null); load(); }} />

      {/* ── Census strip ────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(132px,1fr))',
                    gap: 8, marginBottom: 14 }}>
        {CENSUS.map(c => (
          <div key={c.label} title={c.hint}
               style={{ border: BORDER, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1,
                          color: c.warn && c.v > 0 ? '#F2CD1A' : c.good ? '#22c55e' : 'inherit' }}>
              {c.v ?? '—'}
            </div>
            <div style={{ fontSize: 11, opacity: .75, marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {caps?.truncated && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 14, fontSize: 12,
                      border: '1px solid rgba(222,42,42,.4)', background: 'rgba(222,42,42,.07)' }}>
          The fleet has reached the {caps.devices}-row page cap — this list and the counts above
          are incomplete. Paging is needed before they can be trusted.
        </div>
      )}

      {/* ── Break glass ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    padding: '10px 14px', borderRadius: 10, marginBottom: 14,
                    border: blockEnforcing ? BORDER : '1px solid rgba(222,42,42,.5)',
                    background: blockEnforcing ? 'transparent' : 'rgba(222,42,42,.08)' }}>
        <ShieldAlert size={16} style={{ flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, lineHeight: 1.5, flex: 1, minWidth: 220 }}>
          {blockEnforcing
            ? <><strong>Blocking is live.</strong> A handset set to <em>BLOCKED</em> is refused on
                every scanner action within 30 seconds.</>
            : <><strong style={{ color: '#DE2A2A' }}>BREAK GLASS IS OPEN — every block is lifted
                fleet-wide.</strong> Blocked handsets are scanning normally right now.</>}
        </div>
        <button onClick={() => flipSetting('device_block_enforce', blockEnforcing ? 'off' : 'on')}
          style={{ ...btnCss, borderColor: blockEnforcing ? 'rgba(222,42,42,.45)' : 'rgba(34,197,94,.45)',
                   color: blockEnforcing ? '#ff7070' : '#22c55e' }}>
          {blockEnforcing ? 'Break glass — lift all blocks' : 'Re-enable blocking'}
        </button>
      </div>

      {/* ── Search ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: BORDER,
                    borderRadius: 8, padding: '6px 10px', marginBottom: 14 }}>
        <Search size={14} />
        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search phone, name, station, hardware id"
          style={{ border: 'none', outline: 'none', background: 'transparent',
                   color: 'inherit', fontSize: 14, flex: 1, minWidth: 0 }} />
      </div>

      {/* ── The phones ──────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 15, fontWeight: 800, margin: '4px 0 10px' }}>
        Phones <span style={{ opacity: .6, fontWeight: 600 }}>({shownDevices.length})</span>
      </h2>

      {/* Cards, not a table — Afshaan uses this from a phone on the floor and an 11-column
          table is unusable there. The grid collapses to one column under ~360px. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 12 }}>
        {shownDevices.map(d => {
          const h       = hwByCode[d.device_code];
          const draft   = drafts[d.device_code] || {};
          const val     = (k) => (draft[k] !== undefined ? draft[k] : (d[k] ?? '') );
          const setD    = (k, v) => setDrafts(x => ({ ...x, [d.device_code]: { ...(x[d.device_code] || {}), [k]: v } }));
          const dirty   = ['label', 'station', 'line'].some(k => draft[k] !== undefined && draft[k] !== (d[k] ?? ''));
          const busy    = busyId === d.device_code;
          const roamed  = (codesByHw[h?.hw_id] || []).length > 1;
          return (
            <div key={d.device_code}
                 style={{ border: d.station_locked ? '1px solid rgba(34,197,94,.4)' : BORDER,
                          borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
                          opacity: d.is_active === false ? .55 : 1 }}>

              {/* code + flags */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 14 }}>
                  {d.device_code}
                </span>
                {d.is_active === false &&
                  <span style={{ fontSize: 10, fontWeight: 800, color: '#DE2A2A' }}>INACTIVE</span>}
                {d.is_attendance_device &&
                  <span title="The gate phone — attendance is locked to it"
                        style={{ fontSize: 10, fontWeight: 800, color: '#F2CD1A' }}>ATTENDANCE</span>}
                {d.has_key
                  ? <KeyRound size={13} style={{ color: '#22c55e' }} title={`Paired — key from ${istStamp(d.enrolled_at)}`} />
                  : <KeyRound size={13} style={{ opacity: .35 }} title="Not paired — holds no signing key" />}
                <span style={{ marginLeft: 'auto', fontSize: 11, opacity: .7 }}
                      title={istStamp(d.last_seen)}>{ago(d.last_seen)}</span>
              </div>

              {/* rename */}
              <input value={val('label')} onChange={e => setD('label', e.target.value)}
                placeholder="Name this phone, e.g. Inward line 1"
                style={{ ...inputCss, width: '100%' }} />

              {/* station + line + lock */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input value={val('station')} onChange={e => setD('station', e.target.value)}
                  placeholder="Station code" style={{ ...inputCss, flex: 2, minWidth: 120 }} />
                <input value={val('line')} onChange={e => setD('line', e.target.value)}
                  placeholder="Line" style={{ ...inputCss, flex: 1, minWidth: 70 }} />
              </div>

              <button onClick={() => saveDevice(d.device_code, { station_locked: !d.station_locked })}
                disabled={busy}
                style={{ ...btnCss, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                         borderColor: d.station_locked ? 'rgba(34,197,94,.45)' : 'var(--border,#404040)',
                         color: d.station_locked ? '#22c55e' : 'inherit' }}>
                {d.station_locked ? <Lock size={14} /> : <Unlock size={14} />}
                <span style={{ fontWeight: 800 }}>{d.station_locked ? 'LOCKED' : 'Not locked'}</span>
                <span style={{ fontWeight: 500, fontSize: 11, opacity: .8 }}>
                  {d.station_locked
                    ? '— pinned to this station, no daily supervisor setup'
                    : '— a supervisor must set this phone up each morning'}
                </span>
              </button>

              {/* scanning status — the hardware row, if this phone runs the app */}
              {h ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ opacity: .7 }}>Scanning</span>
                  <select value={h.status} disabled={busyId === h.hw_id}
                    onChange={e => saveHw(h.hw_id, { status: e.target.value })}
                    style={{ ...inputCss, flex: 1, fontWeight: 700,
                             background: STATUS_STYLE[h.status]?.bg || 'transparent',
                             color: STATUS_STYLE[h.status]?.fg || 'inherit' }}>
                    {STATUSES.map(s => <option key={s} value={s}>{STATUS_STYLE[s].label}</option>)}
                  </select>
                </label>
              ) : (
                <div style={{ fontSize: 11.5, opacity: .7, lineHeight: 1.5 }}>
                  No handset has claimed this code, so scanning cannot be disabled for it — a
                  phone on the website sends no hardware ID and there is nothing to block.
                </div>
              )}
              {h && roamed && (
                <div style={{ fontSize: 11, color: '#F2CD1A' }}>
                  This handset has been used as {(codesByHw[h.hw_id] || []).length} different stations.
                </div>
              )}
              {h && (
                <div style={{ fontSize: 10.5, opacity: .55, fontFamily: 'ui-monospace, monospace' }}>
                  {h.hw_id} · {h.last_action || 'no action yet'} · {h.sightings ?? 0} sightings
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
                <button onClick={() => mintPair(d.device_code)} disabled={busy}
                  title="Mints a 6-digit code to type into the Scanner app on that phone"
                  style={{ ...btnCss, color: '#F2CD1A', borderColor: 'rgba(242,205,26,.45)' }}>
                  {busy ? '…' : d.has_key ? 'Re-pair this phone' : 'Pair this phone'}
                </button>
                {dirty && (
                  <button onClick={() => saveDevice(d.device_code, {
                            label:   val('label'),
                            station: val('station'),
                            line:    val('line'),
                          })} disabled={busy}
                    style={{ ...btnCss, marginLeft: 'auto', border: 'none',
                             background: '#F2CD1A', color: '#1f1f1f' }}>
                    {busy ? '…' : 'Save'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {shownDevices.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', opacity: .7, fontSize: 14 }}>
          {devices.length === 0 ? 'No devices in the register.' : 'No phones match that search.'}
        </div>
      )}

      {/* ── Unclaimed handsets ──────────────────────────────────────────── */}
      <h2 style={{ fontSize: 15, fontWeight: 800, margin: '26px 0 6px' }}>
        Handsets with no station code <span style={{ opacity: .6, fontWeight: 600 }}>({orphanHw.length})</span>
      </h2>
      <p style={{ fontSize: 12, opacity: .75, lineHeight: 1.55, margin: '0 0 10px' }}>
        Phones running the Scanner app that no register row claims — new arrivals, the
        attendance gate phone and Lookup all land here, because those flows send no station
        code. Name one while you are standing next to it; that knowledge is unrecoverable an
        hour later. Blocking one here stops it scanning everywhere.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 10 }}>
        {orphanHw.map(h => {
          const dr = hwDrafts[h.hw_id];
          const dirty = dr !== undefined && dr !== (h.label || '');
          return (
            <div key={h.hw_id} style={{ border: BORDER, borderRadius: 10, padding: 12,
                                        display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, opacity: .8 }}>{h.hw_id}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, opacity: .7 }}
                      title={istStamp(h.last_seen)}>{ago(h.last_seen)}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={dr !== undefined ? dr : (h.label || '')}
                  onChange={e => setHwD(x => ({ ...x, [h.hw_id]: e.target.value }))}
                  placeholder="e.g. Gate phone" style={{ ...inputCss, flex: 1 }} />
                {dirty && (
                  <button onClick={() => saveHw(h.hw_id, { label: dr })} disabled={busyId === h.hw_id}
                    style={{ ...btnCss, border: 'none', background: '#F2CD1A', color: '#1f1f1f' }}>
                    {busyId === h.hw_id ? '…' : 'Save'}
                  </button>
                )}
              </div>
              <select value={h.status} disabled={busyId === h.hw_id}
                onChange={e => saveHw(h.hw_id, { status: e.target.value })}
                style={{ ...inputCss, fontWeight: 700,
                         background: STATUS_STYLE[h.status]?.bg || 'transparent',
                         color: STATUS_STYLE[h.status]?.fg || 'inherit' }}>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_STYLE[s].label}</option>)}
              </select>
              <div style={{ fontSize: 10.5, opacity: .55 }}>
                {h.last_station || 'no station'} · {h.last_action || 'no action'} · {h.last_ip || 'no ip'}
              </div>
            </div>
          );
        })}
        {orphanHw.length === 0 && (
          <div style={{ fontSize: 13, opacity: .6 }}>None — every reporting handset has claimed a station code.</div>
        )}
      </div>

      {/* ── Display-only toggles ────────────────────────────────────────── */}
      {/* ⭐ Each shows what it WOULD flag right now. 2026-09-03's attendance enforcement flip
          refused the whole floor because nobody could see the blast radius in advance; a switch
          here is never thrown blind. These FLAG ONLY — unlike the block above, nothing in the
          worker refuses a scan because of them. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))',
                    gap: 12, marginTop: 26 }}>
        {TOGGLES.map(t => {
          const on = settings[t.key]?.value === 'on';
          return (
            <div key={t.key} style={{ border: BORDER, borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <strong style={{ fontSize: 14 }}>{t.title}</strong>
                <button onClick={() => flipSetting(t.key, on ? 'off' : 'on')}
                  style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 999,
                           fontSize: 12, fontWeight: 800, cursor: 'pointer', border: 'none',
                           background: on ? '#22c55e' : 'var(--border,#404040)',
                           color: on ? '#0b1f12' : 'inherit' }}>
                  {on ? 'ON' : 'OFF'}
                </button>
              </div>
              <p style={{ fontSize: 12, opacity: .75, margin: '8px 0 10px', lineHeight: 1.5 }}>{t.body}</p>
              <div style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6,
                            background: 'rgba(242,205,26,.08)', border: '1px solid rgba(242,205,26,.25)' }}>
                Right now this would flag <strong>{t.would ?? '—'}</strong>{' '}
                {t.would === 1 ? 'handset' : 'handsets'}. Flags only — nothing is blocked.
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
