'use client';
// X1 — Exits (HR): open exits board · Google accounts to action (due first; the three actions for Google
// admins) · the one-time backfill review of exits recorded before X1. Every gate is the worker's.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { LogOut, Mail, History, Check, Ban, Clock, RefreshCw, ShieldOff } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { EXIT_REASONS, GOOGLE_ITEM_STATUSES, ACCESS_LABEL, blockerText, exitError, labelOfList } from '../../../lib/exits.js';
import { ToneBadge, Card, inp, primaryBtn, ghostBtn, muted } from '../../../components/HiringBits.js';

const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };
const th = { textAlign: 'left', padding: '7px 8px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 13 };
const table = { width: '100%', borderCollapse: 'collapse' };

export default function ExitsPage() {
  const { session, perms } = useAuth();
  const [d, setD] = useState(null);
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getExits', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load exits.</div>;
  if (!d) return <Spinner />;

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <OpenExits d={d} />
      <GoogleItems d={d} session={session} onChanged={load} />
      <Backfill d={d} session={session} onChanged={load} />
      <AccessLeft d={d} session={session} onChanged={load} />
    </div>
  );
}

function OpenExits({ d }) {
  const router = useRouter();
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LogOut size={13} /> Open exits ({d.exits.length})</span>}>
      {d.exits.length === 0 ? <div style={muted}>Nobody is on notice.</div> : (
        <table style={table}>
          <thead><tr><th style={th}>Person</th><th style={th}>Reason</th><th style={th}>Last working day</th><th style={th}>Checklist</th><th style={th}>Before it can close</th></tr></thead>
          <tbody>
            {d.exits.map(x => (
              <tr key={x.exit_id} onClick={() => router.push(`/people/detail/?id=${x.employee.id}`)} style={{ cursor: 'pointer' }}>
                <td style={td}><div style={{ fontWeight: 600 }}>{x.employee.full_name}</div><div style={muted}>{x.employee.employee_code}{x.employee.department?.name ? ` · ${x.employee.department.name}` : ''}</div></td>
                <td style={td}>{labelOfList(EXIT_REASONS, x.reason_code)}<div style={muted}>started by {x.initiated_by}</div></td>
                <td style={td}>{fmtDate(x.lwd)}<div style={{ ...muted, color: x.days_left < 0 ? 'var(--bad-fg)' : undefined }}>
                  {x.days_left > 0 ? `${x.days_left} days left` : x.days_left === 0 ? 'today' : `${-x.days_left} days past`}</div></td>
                <td style={td}>{x.progress.done}/{x.progress.required}</td>
                <td style={{ ...td, fontSize: 12 }}>
                  {x.blockers.length === 0 ? <ToneBadge tone="ok" label="Ready to close" />
                    : <ul style={{ margin: 0, paddingLeft: 16 }}>{x.blockers.slice(0, 4).map((b, i) => <li key={i}>{blockerText(b)}</li>)}{x.blockers.length > 4 && <li>+{x.blockers.length - 4} more</li>}</ul>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function GoogleItems({ d, session, onChanged }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(null);
  const [keep, setKeep] = useState(null);   // item id whose keep form is open
  const [until, setUntil] = useState('');
  const [why, setWhy] = useState('');
  async function act(item, action, extra = {}) {
    const verb = action === 'transfer_and_suspend' ? `Transfer ${item.work_email}'s Drive to their manager, then suspend the account?`
      : action === 'suspend' ? `Suspend ${item.work_email} now? Their Drive stays with the suspended account.` : null;
    if (verb && !window.confirm(verb)) return;
    setBusy(item.id);
    try {
      const r = await podiumopsPost('actGoogleExitItem', { item_id: item.id, action, ...extra }, session);
      showToast(r?.still_running ? 'Transfer still running — check again later' : r?.status === 'gone' ? 'Google has no such account — closed' : 'Done', 'success');
      setKeep(null); onChanged();
    }
    catch (e) { showToast(exitError(e), 'error'); }
    finally { setBusy(null); }
  }
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Mail size={13} /> Google accounts to action ({d.google_due} due)</span>}>
      <div style={{ ...muted, marginBottom: 8 }}>
        An exited person's Google account is never suspended automatically. While it stays active it can still sign in and
        it still costs a Workspace seat. {d.can_act_google ? '' : 'A Google admin (Afshaan, Vinay, Mohit) takes the action.'}
      </div>
      {d.google.length === 0 ? <div style={muted}>Nothing to action.</div> : (
        <table style={table}>
          <thead><tr><th style={th}>Person</th><th style={th}>Account</th><th style={th}>Status</th><th style={th}>Open for</th>{d.can_act_google && <th style={th}>Action</th>}</tr></thead>
          <tbody>
            {d.google.map(g => {
              const st = GOOGLE_ITEM_STATUSES.find(s => s.id === g.status);
              return (
                <tr key={g.id}>
                  <td style={td}><div style={{ fontWeight: 600 }}>{g.employee?.full_name || '—'}</div><div style={muted}>{g.employee?.employee_code}</div></td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{g.work_email}</td>
                  <td style={td}>
                    <ToneBadge tone={g.status === 'transfer_pending' ? 'warn' : g.due ? 'bad' : (st?.tone || 'neutral')} label={g.due && g.status === 'kept' ? 'Keep date passed' : (st?.label || g.status)} />
                    {g.status === 'kept' && <div style={muted}>until {fmtDate(g.keep_until)} — {g.keep_reason}</div>}
                    {g.transfer_id && g.status === 'open' && <div style={muted}>Drive transfer started — the suspend did not finish; retry</div>}
                    {g.last_error && <div style={{ ...muted, color: 'var(--bad-fg)' }}>{g.last_error}</div>}
                  </td>
                  <td style={td}>{g.days_open != null ? `${g.days_open} day${g.days_open === 1 ? '' : 's'}` : '—'}</td>
                  {d.can_act_google && (
                    <td style={td}>
                      {g.status === 'transfer_pending' ? (
                        <button style={smallBtn} disabled={busy === g.id} onClick={() => act(g, 'check_transfer')}><RefreshCw size={12} /> Check transfer</button>
                      ) : keep === g.id ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <input type="date" style={{ ...inp, width: 150 }} value={until} min={d.today} onChange={e => setUntil(e.target.value)} />
                          <input style={{ ...inp, width: 180, fontFamily: 'var(--font-ui)' }} placeholder="Why (e.g. mailbox handover)" value={why} onChange={e => setWhy(e.target.value)} />
                          <button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy === g.id} onClick={() => act(g, 'keep', { keep_until: until, keep_reason: why })}>Keep</button>
                          <button style={smallBtn} onClick={() => setKeep(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy === g.id} onClick={() => act(g, 'transfer_and_suspend')}><Check size={12} /> {g.transfer_id ? 'Finish: suspend' : 'Drive → manager, suspend'}</button>
                          <button style={smallBtn} disabled={busy === g.id} onClick={() => act(g, 'suspend')}><Ban size={12} /> Suspend now</button>
                          <button style={smallBtn} disabled={busy === g.id} onClick={() => { setKeep(g.id); setUntil(''); setWhy(''); }}><Clock size={12} /> Keep until…</button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Backfill({ d, session, onChanged }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState({});   // employee_id → { reason_code, lwd }
  const [busy, setBusy] = useState(null);
  const get = (id, k, def) => (rows[id] && k in rows[id] ? rows[id][k] : def);
  const set = (id, patch) => setRows(r => ({ ...r, [id]: { ...(r[id] || {}), ...patch } }));
  async function confirm(e) {
    const reason_code = get(e.id, 'reason_code', '');
    const lwd = get(e.id, 'lwd', e.date_exited || '');
    if (!reason_code) { showToast('Pick a reason', 'error'); return; }
    if (!lwd) { showToast('Confirm the last working day', 'error'); return; }
    if (!window.confirm(`Record ${e.full_name}'s exit as ${labelOfList(EXIT_REASONS, reason_code)}, last working day ${fmtDate(lwd)}?`)) return;
    setBusy(e.id);
    try { await podiumopsPost('backfillExit', { employee_id: e.id, reason_code, lwd }, session); showToast('Recorded', 'success'); onChanged(); }
    catch (err) { showToast(exitError(err), 'error'); }
    finally { setBusy(null); }
  }
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><History size={13} /> Backfill review ({d.backfill.length})</span>}>
      <div style={{ ...muted, marginBottom: 8 }}>
        People exited before exits were recorded in Podium. Pick the reason and confirm the real last working day — no guessing.
        The old note is kept on the record. Changing the date changes the month their salary stops counting toward SG&amp;A.
      </div>
      {d.backfill.length === 0 ? <div style={muted}>Nothing left to review.</div> : (
        <table style={table}>
          <thead><tr><th style={th}>Person</th><th style={th}>Old note</th><th style={th}>Reason *</th><th style={th}>Last working day *</th><th style={th}></th><th style={th}>Still has</th></tr></thead>
          <tbody>
            {d.backfill.map(e => (
              <tr key={e.id}>
                <td style={td}><div style={{ fontWeight: 600 }}>{e.full_name}</div><div style={muted}>{e.employee_code}</div></td>
                <td style={{ ...td, fontSize: 12, color: e.exit_reason ? 'var(--text-2)' : 'var(--warn-fg)' }}>{e.exit_reason || 'No reason recorded'}</td>
                <td style={td}>
                  <select style={{ ...inp, width: 170 }} value={get(e.id, 'reason_code', '')} onChange={ev => set(e.id, { reason_code: ev.target.value })}>
                    <option value="">Pick…</option>
                    {EXIT_REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <input type="date" style={{ ...inp, width: 150 }} value={get(e.id, 'lwd', e.date_exited || '')} max={d.today} onChange={ev => set(e.id, { lwd: ev.target.value })} />
                  <div style={muted}>on record: {fmtDate(e.date_exited)}</div>
                </td>
                <td style={td}><button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy === e.id} onClick={() => confirm(e)}>Confirm</button></td>
                <td style={td}><AccessCell e={e} session={session} onChanged={onChanged} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// What an exited person can still reach. Never revoked automatically — HR presses Revoke per person (logged).
function AccessCell({ e, session, onChanged }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  async function run(action, msg, confirmText) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try { await podiumopsPost(action, { employee_id: e.id }, session); showToast(msg, 'success'); onChanged(); }
    catch (err) { showToast(exitError(err), 'error'); }
    finally { setBusy(false); }
  }
  const left = e.access_left || [];
  const revocable = left.filter(k => k !== 'assets');
  return (
    <div style={{ fontSize: 12 }}>
      {!e.auth_linked && <div style={muted}>No LOT login linked</div>}
      {left.length === 0 ? (e.auth_linked && <div style={muted}>Nothing</div>)
        : <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--bad-fg)' }}>{left.map(k => <li key={k}>{ACCESS_LABEL[k] || k}{k === 'assets' ? ` (${e.access.assets})` : ''}</li>)}</ul>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        {revocable.length > 0 && <button style={smallBtn} disabled={busy}
          onClick={() => run('revokeExitedAccess', 'Access revoked', `Revoke ${e.full_name}'s LOT login, Podium role, salary access and Google-admin power?`)}><ShieldOff size={12} /> Revoke access</button>}
        {e.can_open_google_item && <button style={smallBtn} disabled={busy}
          onClick={() => run('openGoogleExitItem', 'Google item opened', `Open a Google account item for ${e.work_email}? Nothing is suspended until a Google admin acts on it.`)}><Mail size={12} /> Open Google item</button>}
      </div>
    </div>
  );
}

function AccessLeft({ d, session, onChanged }) {
  if (!d.access_left?.length && d.access_check_ok !== false) return null;
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ShieldOff size={13} /> Exited, still with access ({d.access_left?.length || 0})</span>}>
      {d.access_check_ok === false && <div style={{ ...muted, color: 'var(--warn-fg)', marginBottom: 6 }}>Could not read every access table — the list may be incomplete.</div>}
      <table style={table}>
        <thead><tr><th style={th}>Person</th><th style={th}>Exited</th><th style={th}>Still has</th></tr></thead>
        <tbody>
          {(d.access_left || []).map(e => (
            <tr key={e.id}>
              <td style={td}><div style={{ fontWeight: 600 }}>{e.full_name}</div><div style={muted}>{e.employee_code}</div></td>
              <td style={td}>{fmtDate(e.date_exited)}</td>
              <td style={td}><AccessCell e={e} session={session} onChanged={onChanged} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
