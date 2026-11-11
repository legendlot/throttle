'use client';
// X1 — the Exit panel on a person's page (Start exit / Resign, the no-dues checklist with its live Snorkel /
// Docket lists, HR's Close + Cancel) and the start modal. Presentation only; every gate is the worker's
// (podiumops-worker getExit / startExit / updateExitItem / updateExit / closeExit / cancelExit).
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { LogOut, Check, Ban, RotateCcw, X, AlertTriangle, Users, ChevronDown, ChevronRight } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtDate, fmtMoney } from '../lib/format.js';
import { EXIT_REASONS, CHECKLIST_OWNERS, AUTO_SOURCE_LABELS, blockerText, exitError, addDaysIso, labelOfList } from '../lib/exits.js';
import { ToneBadge, Card, KV, F, Row, inp, primaryBtn, ghostBtn, dangerBtn, muted } from './HiringBits.js';

const ITEM_TONE = { open: 'warn', done: 'ok', na: 'neutral' };
const ITEM_LABEL = { open: 'Open', done: 'Done', na: 'N/A' };
const smallBtn = { ...ghostBtn, padding: '3px 9px', fontSize: 11 };

function canTick(role, item) {
  if (item.auto_source === 'lot_access') return false;
  return role === 'hr' || (role === 'manager' && item.owner === 'manager');
}

export function ExitPanel({ employeeId, session, onChanged }) {
  const { showToast } = useToast();
  const [d, setD] = useState(null);          // null = loading, false = no access
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState([]);

  const load = useCallback(() => {
    if (!session || !employeeId) return;
    podiumopsGet('getExit', { employee_id: employeeId }, session).then(setD).catch(() => setD(false));
  }, [employeeId, session]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!d || d.role !== 'hr' || d.exit?.status !== 'open') return;
    podiumopsGet('getDocuments', { employee_id: employeeId }, session).then(r => setDocs(r.documents || [])).catch(() => setDocs([]));
  }, [d, employeeId, session]);

  if (!d) return null;
  const x = d.exit;
  const open = x?.status === 'open';

  async function run(action, body, msg) {
    setBusy(true);
    try { const r = await podiumopsPost(action, body, session); if (msg) showToast(msg, 'success'); load(); onChanged && onChanged(); return r; }
    catch (e) { showToast(exitError(e), 'error'); return null; }
    finally { setBusy(false); }
  }
  function close() {
    if (!window.confirm(`Close the exit? ${d.employee.full_name} becomes Exited on ${fmtDate(x.lwd)}, their LOT login, Podium role and salary access end, and their reports move up a level. Google is NOT suspended — that is a separate prompt on Exits.`)) return;
    run('closeExit', { exit_id: x.id }, 'Exit closed');
  }
  function cancel() {
    const reason = window.prompt('Cancel this exit (e.g. resignation withdrawn)? Reason:', '');
    if (reason === null) return;
    run('cancelExit', { exit_id: x.id, reason: reason.trim() }, 'Exit cancelled');
  }

  const startLabel = d.role === 'employee' ? 'Resign' : 'Start exit';
  const canStart = !open && d.employee.status !== 'exited' && !!d.role;

  return (
    <Card title="Exit" style={{ gridColumn: '1 / -1' }}
      right={canStart ? <button onClick={() => setStarting(true)} style={d.role === 'employee' ? ghostBtn : dangerBtn}><LogOut size={13} /> {startLabel}</button> : null}>
      {starting && <StartExitModal d={d} session={session} onClose={() => setStarting(false)} onStarted={() => { setStarting(false); load(); onChanged && onChanged(); }} />}
      {!x ? <div style={muted}>No exit recorded.</div>
        : !open ? <ClosedExit x={x} role={d.role} session={session} onSaved={load} />
        : <>
          <ExitHeader x={x} d={d} session={session} onSaved={load} />
          <Checklist items={d.items} live={d.live} role={d.role} docs={docs} busy={busy}
            onSet={(item, status, note, document_id) => run('updateExitItem', { item_id: item.id, status, note, ...(document_id !== undefined ? { document_id } : {}) }, null)} />
          {d.can_manage && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              {d.blockers.length > 0 && (
                <div style={{ ...muted, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn-fg)', fontWeight: 600, marginBottom: 4 }}><AlertTriangle size={13} /> Before it can close</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{d.blockers.map((b, i) => <li key={i}>{blockerText(b)}</li>)}</ul>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={cancel} style={ghostBtn} disabled={busy}><Ban size={13} /> Cancel exit</button>
                <button onClick={close} style={{ ...primaryBtn, opacity: d.blockers.length ? 0.5 : 1 }} disabled={busy || d.blockers.length > 0}><Check size={13} /> Close exit</button>
              </div>
            </div>
          )}
        </>}
    </Card>
  );
}

function ClosedExit({ x, role, session, onSaved }) {
  const { showToast } = useToast();
  const [interview, setInterview] = useState(x.exit_interview || '');
  async function save(body) {
    try { await podiumopsPost('updateExit', { exit_id: x.id, ...body }, session); showToast('Saved', 'success'); onSaved(); }
    catch (e) { showToast(exitError(e), 'error'); }
  }
  return (
    <div style={{ fontSize: 13 }}>
      <KV k="Status" v={x.status === 'cancelled' ? `Cancelled — ${x.cancel_reason || ''}` : 'Closed'} />
      <KV k="Reason" v={labelOfList(EXIT_REASONS, x.reason_code)} />
      {x.reason_note && <KV k="Note" v={x.reason_note} />}
      <KV k="Last working day" v={fmtDate(x.lwd)} />
      {x.initiated_by === 'backfill' && <div style={muted}>Recorded in the X1 backfill review (exited before exits were tracked).</div>}
      {/* A closed exit still takes the interview notes and the private rehire flag (HR) — nothing else. */}
      {role === 'hr' && x.status === 'closed' && (
        <div style={{ marginTop: 8 }}>
          <F label="Eligible for rehire (private to HR)">
            <select style={inp} value={x.rehire_eligible == null ? '' : String(x.rehire_eligible)}
              onChange={e => save({ rehire_eligible: e.target.value === '' ? null : e.target.value === 'true' })}>
              <option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </F>
          <F label="Exit interview notes"><textarea style={{ ...inp, minHeight: 60, fontFamily: 'var(--font-ui)' }} value={interview} onChange={e => setInterview(e.target.value)} /></F>
          {(interview || '') !== (x.exit_interview || '') && <button style={smallBtn} onClick={() => save({ exit_interview: interview })}>Save notes</button>}
        </div>
      )}
    </div>
  );
}

function ExitHeader({ x, d, session, onSaved }) {
  const { showToast } = useToast();
  const [edit, setEdit] = useState(false);
  const [lwd, setLwd] = useState(x.lwd);
  const [why, setWhy] = useState(x.lwd_override_reason || '');
  const [interview, setInterview] = useState(x.exit_interview || '');
  const hr = d.role === 'hr';
  const def = addDaysIso(x.notice_date, d.notice_days);
  async function save(body) {
    try { await podiumopsPost('updateExit', { exit_id: x.id, ...body }, session); showToast('Saved', 'success'); setEdit(false); onSaved(); }
    catch (e) { showToast(exitError(e), 'error'); }
  }
  const left = d.days_left;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <ToneBadge tone="bad" label="On notice" />
        <b>{labelOfList(EXIT_REASONS, x.reason_code)}</b>
        <span style={muted}>· notice {fmtDate(x.notice_date)} · LWD <b style={{ color: 'var(--text-1)' }}>{fmtDate(x.lwd)}</b>
          {left != null && <> · {left > 0 ? `${left} day${left === 1 ? '' : 's'} left` : left === 0 ? 'last day today' : `${-left} days past LWD`}</>}
          {' '}· started by {x.initiated_by}</span>
        {d.progress && <span style={muted}>· {d.progress.done}/{d.progress.required} required lines</span>}
        {hr && !edit && <button onClick={() => setEdit(true)} style={smallBtn}>Edit</button>}
      </div>
      {x.reason_note && <div style={{ ...muted, marginTop: 4 }}>{x.reason_note}</div>}
      {x.lwd_override_reason && <div style={{ ...muted, marginTop: 2 }}>LWD differs from the notice period: {x.lwd_override_reason}</div>}
      {hr && edit && (
        <div style={{ marginTop: 8, padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
          <Row>
            <F label={`Last working day (notice period ends ${fmtDate(def)})`}><input type="date" style={inp} value={lwd} min={x.notice_date} onChange={e => setLwd(e.target.value)} /></F>
            {(lwd !== def || lwd < d.today.slice(0, 8) + '01') && <F label="Why it differs / is in an earlier month *"><input style={inp} value={why} onChange={e => setWhy(e.target.value)} /></F>}
          </Row>
          <F label="Eligible for rehire (private to HR)">
            <select style={inp} value={x.rehire_eligible == null ? '' : String(x.rehire_eligible)}
              onChange={e => save({ rehire_eligible: e.target.value === '' ? null : e.target.value === 'true' })}>
              <option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </F>
          <F label="Exit interview notes"><textarea style={{ ...inp, minHeight: 60, fontFamily: 'var(--font-ui)' }} value={interview} onChange={e => setInterview(e.target.value)} /></F>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEdit(false)} style={ghostBtn}>Cancel</button>
            <button onClick={() => {
              // Only what changed (the worker re-judges the LWD only when it changes).
              const body = {};
              if (lwd !== x.lwd) { body.lwd = lwd; body.lwd_override_reason = why; }
              else if ((why || '') !== (x.lwd_override_reason || '')) body.lwd_override_reason = why;
              if ((interview || '') !== (x.exit_interview || '')) body.exit_interview = interview;
              if (!Object.keys(body).length) { setEdit(false); return; }
              save(body);
            }} style={primaryBtn}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Checklist({ items, live, role, docs, busy, onSet }) {
  const groups = CHECKLIST_OWNERS.map(o => ({ ...o, items: (items || []).filter(i => i.owner === o.id) })).filter(g => g.items.length);
  return (
    <div>
      {live && !live.ok && <div style={{ ...muted, color: 'var(--warn-fg)', marginBottom: 6 }}>Snorkel / Docket could not be read just now — the live lists may be incomplete.</div>}
      {groups.map(g => (
        <div key={g.id} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>{g.label}</div>
          {g.items.map(it => <ItemRow key={it.id} it={it} live={live} role={role} docs={docs} busy={busy} onSet={onSet} />)}
        </div>
      ))}
    </div>
  );
}

function ItemRow({ it, live, role, docs, busy, onSet }) {
  const [mode, setMode] = useState(null);   // 'done' | 'na' while the note box is open
  const [note, setNote] = useState(it.note || '');
  const [doc, setDoc] = useState(it.document_id || '');
  // Unverifiable assets: only HR, with a note (the worker + exit_update_item enforce it).
  const assetsHrOnly = it.auto_source === 'snorkel_assets' && live && !live.assets_verifiable && role !== 'hr';
  const tick = canTick(role, it) && !assetsHrOnly;
  const isFnf = it.line_key === 'fnf';
  async function submit() {
    await onSet(it, mode, note, role === 'hr' ? (doc || null) : undefined);
    setMode(null);
  }
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <ToneBadge tone={ITEM_TONE[it.status]} label={ITEM_LABEL[it.status]} />
        <span style={{ flex: 1, minWidth: 160 }}>{it.title}{!it.required && <span style={muted}> · optional</span>}
          {it.auto_source && <span style={muted}> · {AUTO_SOURCE_LABELS[it.auto_source]}</span>}</span>
        {tick && !isFnf && !mode && (
          it.status === 'open'
            ? <>
                <button onClick={() => setMode('done')} style={smallBtn} disabled={busy}><Check size={12} /> Done</button>
                {it.allow_na && <button onClick={() => setMode('na')} style={smallBtn} disabled={busy}>N/A</button>}
              </>
            : <button onClick={() => onSet(it, 'open', it.note || '')} style={smallBtn} disabled={busy}><RotateCcw size={12} /> Reopen</button>
        )}
      </div>
      {isFnf && <div style={{ ...muted, marginTop: 2 }}>F&amp;F — later phase. Not calculated in Podium and not needed to close.</div>}
      {it.note && !mode && <div style={{ ...muted, marginTop: 2 }}>{it.note}{it.done_at && ` · ${fmtDate(it.done_at)}`}</div>}
      {mode && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, flex: 1, minWidth: 180, fontFamily: 'var(--font-ui)' }} value={note}
            placeholder={mode === 'na' ? 'Why it does not apply *' : (it.auto_source === 'snorkel_assets' && live && !live.assets_verifiable) ? 'How the assets were checked *' : 'Note / handover link (optional)'}
            onChange={e => setNote(e.target.value)} />
          {role === 'hr' && docs.length > 0 && (
            <select style={{ ...inp, width: 200 }} value={doc} onChange={e => setDoc(e.target.value)}>
              <option value="">No document</option>
              {docs.map(x => <option key={x.id} value={x.id}>{x.title || x.file_name}</option>)}
            </select>
          )}
          <button onClick={submit} style={{ ...primaryBtn, padding: '5px 12px' }} disabled={busy}>Save {ITEM_LABEL[mode]}</button>
          <button onClick={() => setMode(null)} style={smallBtn}><X size={12} /></button>
        </div>
      )}
      {live && it.auto_source === 'snorkel_assets' && <>
        <LiveList rows={live.assets} empty={live.assets_verifiable ? 'No assets assigned in Snorkel.' : 'No assets linked to their login.'}
          render={a => <>{a.asset_code} · {a.name}{a.category ? ` · ${a.category}` : ''} <span style={muted}>({String(a.status).replace(/_/g, ' ')})</span></>} />
        {!live.assets_verifiable && (
          <Warn>Cannot verify automatically{(live.unlinked_assets || []).length ? ' — these assets carry their name but no linked user' : ' — no LOT login is linked to this person'}.
            HR checks by hand and marks this line Done with a note.
            {(live.unlinked_assets || []).length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{live.unlinked_assets.map(a => <li key={a.id}>{a.asset_code} · {a.name} ({String(a.status).replace(/_/g, ' ')})</li>)}</ul>}
          </Warn>
        )}
      </>}
      {live && it.auto_source === 'open_work' && <LiveList rows={live.tasks} empty="No open Docket tasks."
        render={t => <>{t.task_no} · {t.title} <span style={muted}>({String(t.status).replace(/_/g, ' ')} · {t.as.replace('_', ' + ')})</span></>} />}
      {live && it.auto_source === 'payment_requests' && <>
        <LiveList rows={live.payment_requests} empty="No open payment requests."
          render={p => <>{p.request_no} · {p.purpose || '—'} <span style={muted}>({String(p.status).replace(/_/g, ' ')}{p.amount != null ? ` · ${fmtMoney(p.amount)}` : ''})</span></>} />
        {!live.payment_requests_verifiable && <Warn>Cannot verify automatically — no LOT login is linked to this person, so their Snorkel requests cannot be found. Finance checks by hand.</Warn>}
      </>}
    </div>
  );
}

function Warn({ children }) {
  return <div style={{ display: 'flex', gap: 6, marginTop: 4, padding: '6px 8px', fontSize: 12, color: 'var(--warn-fg)', background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)', borderRadius: 'var(--radius-sm)' }}>
    <AlertTriangle size={13} style={{ flex: 'none', marginTop: 1 }} /><div>{children}</div></div>;
}

function LiveList({ rows, empty, render }) {
  if (!rows?.length) return <div style={{ ...muted, marginTop: 2, paddingLeft: 4 }}>{empty}</div>;
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 22, fontSize: 12 }}>
      {rows.map(r => <li key={r.id}>{render(r)}</li>)}
    </ul>
  );
}

// ── Start exit / Resign ──────────────────────────────────────────────────────
function StartExitModal({ d, session, onClose, onStarted }) {
  const { showToast } = useToast();
  const self = d.role === 'employee';
  const hr = d.role === 'hr';
  const [reason, setReason] = useState(self ? 'resignation' : '');
  const [note, setNote] = useState('');
  const [noticeDate, setNoticeDate] = useState(d.today);
  const def = addDaysIso(noticeDate, d.notice_days);
  const [lwd, setLwd] = useState('');
  const [why, setWhy] = useState('');
  const [rehire, setRehire] = useState('');
  const [busy, setBusy] = useState(false);
  const effLwd = hr && lwd ? lwd : def;
  const monthStartIso = d.today.slice(0, 8) + '01';
  // Non-HR: notice at most 7 days back (the worker enforces it); never before they joined.
  const minNotice = [hr ? null : addDaysIso(d.today, -7), d.employee.date_joined].filter(Boolean).sort().pop() || undefined;

  async function submit() {
    if (!reason) { showToast('Pick a reason', 'error'); return; }
    if (!self && !noticeDate) { showToast('Pick the notice date', 'error'); return; }
    if (!window.confirm(self
      ? `Resign? Your last working day will be ${fmtDate(def)} (${d.notice_days} days' notice). HR is told through Podium.`
      : `Start the exit for ${d.employee.full_name}? Last working day ${fmtDate(effLwd)}. They stay Active (on notice) until HR closes the exit.`)) return;
    setBusy(true);
    try {
      const body = { employee_id: d.employee.id, reason_code: reason, reason_note: note.trim() || null };
      if (!self) body.notice_date = noticeDate;
      if (hr && ((lwd && lwd !== def) || effLwd < monthStartIso)) { body.lwd = effLwd; body.lwd_override_reason = why.trim(); }
      if (hr && rehire !== '') body.rehire_eligible = rehire === 'true';
      await podiumopsPost('startExit', body, session);
      showToast(self ? 'Resignation recorded' : 'Exit started', 'success');
      onStarted();
    } catch (e) { showToast(exitError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={overlay}>
      <div style={modal} role="dialog" aria-modal="true" aria-label={self ? 'Resign' : 'Start exit'}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
          <LogOut size={16} /> {self ? 'Resign' : `Start exit — ${d.employee.full_name}`}
          <span style={{ flex: 1 }} /><button onClick={onClose} style={{ ...smallBtn, border: 'none' }}><X size={14} /></button>
        </div>
        {!self && (
          <F label="Reason *">
            <select style={inp} value={reason} onChange={e => setReason(e.target.value)}>
              <option value="">Pick…</option>
              {EXIT_REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </F>
        )}
        <F label={reason === 'other' ? 'Note *' : 'Note (optional)'}><input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={note} onChange={e => setNote(e.target.value)} /></F>
        <Row>
          <F label="Notice date">{self ? <div style={inp}>{fmtDate(d.today)}</div>
            : <input type="date" style={inp} value={noticeDate} min={minNotice} max={d.today} onChange={e => setNoticeDate(e.target.value)} />}</F>
          <F label={`Last working day${hr ? '' : ` (+${d.notice_days} days)`}`}>
            {hr ? <input type="date" style={inp} value={lwd || def} min={noticeDate} onChange={e => setLwd(e.target.value)} />
              : <div style={inp}>{fmtDate(def)}</div>}
          </F>
        </Row>
        {hr && (lwd && lwd !== def || effLwd < monthStartIso) && <F label={effLwd < monthStartIso ? 'The last working day is in an earlier (closed) month — why? *' : `Why it differs from the ${d.notice_days}-day notice period *`}><input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={why} onChange={e => setWhy(e.target.value)} /></F>}
        {hr && (
          <F label="Eligible for rehire (private to HR)">
            <select style={inp} value={rehire} onChange={e => setRehire(e.target.value)}>
              <option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </F>
        )}
        <div style={{ ...muted, margin: '4px 0 12px' }}>
          They stay Active — shown as On notice — until HR closes the exit after the last working day. The no-dues checklist is built now.
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={ghostBtn} disabled={busy}>Cancel</button>
          <button onClick={submit} style={primaryBtn} disabled={busy}><LogOut size={13} /> {busy ? 'Saving…' : self ? 'Resign' : 'Start exit'}</button>
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 120, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '10vh 16px', overflow: 'auto' };
const modal = { width: 'min(520px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px', color: 'var(--text-1)' };

// ── /me: your own exit (Resign) + "Your team" (managers without podium_view reach their reports' exits here) ──
export function MyExitBlock({ employeeId, session }) {
  const [d, setD] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getMyTeamExits', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
      {employeeId && <ExitPanel employeeId={employeeId} session={session} onChanged={load} />}
      {d && d.team?.length > 0 && (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={13} /> Your team — exits</span>}>
          <div style={{ ...muted, marginBottom: 6 }}>Start a report’s exit, or sign off the manager lines (open work handed over) on one already open.</div>
          {d.team.map(t => (
            <div key={t.id} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <button onClick={() => setOpenId(openId === t.id ? null : t.id)} style={{ ...smallBtn, border: 'none', padding: 2 }}>
                  {openId === t.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span style={{ flex: 1 }}>{t.full_name} <span style={muted}>{t.employee_code}{t.job_title ? ` · ${t.job_title}` : ''}{t.direct ? '' : ' · indirect'}</span></span>
                {t.on_notice && <ToneBadge tone="bad" label="On notice" />}
                <button onClick={() => setOpenId(openId === t.id ? null : t.id)} style={smallBtn}><LogOut size={12} /> Exit</button>
              </div>
              {openId === t.id && <div style={{ marginTop: 8 }}><ExitPanel employeeId={t.id} session={session} onChanged={load} /></div>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
