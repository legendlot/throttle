'use client';
// J2 — /onboarding (HR): Joiners (open onboardings × lines, overdue in red, Start / Complete / Cancel, "joined
// without an onboarding") · Profile completion (launch the one-time campaign, per-field totals, per-person missing
// labels — never values) · Change requests (PAN / bank, approve / reject) · Export (XPayroll CSV, salary-access only).
// Every gate is the worker's (getOnboardingBoard / getProfileCompletion / getProfileChangeRequests / exportXPayroll …).
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Megaphone, Download, Check, X } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { OB_STATE, CHANGE_FIELD_LABELS, obError } from '../../../lib/onboarding.js';
import { Card, ToneBadge, inp, primaryBtn, ghostBtn, muted } from '../../../components/HiringBits.js';

const TABS = [
  { id: 'joiners', label: 'Joiners' },
  { id: 'profile', label: 'Profile completion' },
  { id: 'changes', label: 'Change requests' },
  { id: 'export', label: 'Export' },
];
const th = { textAlign: 'left', padding: '6px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '6px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 13 };
const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };

export default function OnboardingPage() {
  const { session, perms } = useAuth();
  const [tab, setTab] = useState('joiners');
  const [board, setBoard] = useState(null);
  const loadBoard = useCallback(() => {
    if (!session) return;
    podiumopsGet('getOnboardingBoard', {}, session).then(setBoard).catch(() => setBoard(false));
  }, [session]);
  useEffect(() => { loadBoard(); }, [loadBoard]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (board === false) return <div style={{ color: 'var(--t3)' }}>Could not load onboarding.</div>;
  if (!board) return <Spinner />;
  const tabs = TABS.filter(t => t.id !== 'export' || board.can_export);

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {tabs.map(t => <div key={t.id} className={'pd-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>
      {tab === 'joiners' && <Joiners board={board} session={session} reload={loadBoard} />}
      {tab === 'profile' && <ProfileCompletion session={session} />}
      {tab === 'changes' && <ChangeRequests session={session} />}
      {tab === 'export' && board.can_export && <ExportTab board={board} session={session} />}
    </div>
  );
}

function Joiners({ board, session, reload }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  async function run(name, body, msg) {
    setBusy(true);
    try { await podiumopsPost(name, body, session); showToast(msg, 'success'); reload(); }
    catch (e) {
      const b = e.body?.blockers;
      showToast(b?.length ? `${obError(e)}: ${b.map(x => x.title).join(', ')}` : obError(e), 'error');
    } finally { setBusy(false); }
  }
  function cancel(o) {
    const reason = window.prompt(`Cancel ${o.employee.full_name}'s onboarding? Reason:`, '');
    if (reason === null) return;
    run('cancelOnboarding', { onboarding_id: o.onboarding_id, reason: reason.trim() }, 'Cancelled');
  }
  const go = (id) => router.push(`/people/detail/?id=${id}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {board.joiners_without.length > 0 && (
        <Card title={`Joined without an onboarding (${board.joiners_without.length})`}>
          {board.joiners_without.map(e => (
            <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '5px 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => go(e.id)}><b>{e.full_name}</b> <span style={muted}>{e.employee_code} · {e.job_title || '—'} · joined {fmtDate(e.date_joined)}</span></span>
              <button style={primaryBtn} disabled={busy} onClick={() => run('startOnboarding', { employee_id: e.id }, 'Onboarding started')}>Start</button>
            </div>
          ))}
        </Card>
      )}
      <Card title={`Open onboardings (${board.onboardings.length})`}>
        {!board.onboardings.length ? <div style={muted}>No open onboardings.</div> : board.onboardings.map(o => (
          <div key={o.onboarding_id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ cursor: 'pointer' }} onClick={() => go(o.employee.id)}><b>{o.employee.full_name}</b></span>
              <span style={muted}>{o.employee.employee_code} · joined {fmtDate(o.employee.date_joined)} · {o.progress.done}/{o.progress.required} required</span>
              {o.overdue > 0 && <ToneBadge tone="bad" label={`${o.overdue} overdue`} />}
              <span style={{ flex: 1 }} />
              <button style={smallBtn} disabled={busy} onClick={() => cancel(o)}>Cancel</button>
              <button style={{ ...primaryBtn, padding: '4px 10px', opacity: o.blockers.length ? 0.5 : 1 }} disabled={busy || o.blockers.length > 0}
                onClick={() => run('completeOnboarding', { onboarding_id: o.onboarding_id }, 'Onboarding complete')}><Check size={12} /> Complete</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
              {o.items.map(i => {
                const st = OB_STATE[i.state] || OB_STATE.open;
                return <span key={i.id} title={`${i.title}${i.due_date ? ` · due ${fmtDate(i.due_date)}` : ''}`}>
                  <ToneBadge tone={i.overdue ? 'bad' : st.tone} label={i.title.replace(/\s*\(.*\)\s*$/, '')} />
                </span>;
              })}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function ProfileCompletion({ session }) {
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [filter, setFilter] = useState('incomplete');
  const load = useCallback(() => {
    podiumopsGet('getProfileCompletion', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);
  if (d === false) return <div style={muted}>Could not load.</div>;
  if (!d) return <Spinner />;
  async function launch() {
    if (!window.confirm(`Launch the profile campaign? Everyone with an incomplete profile (${d.incomplete} of ${d.active}) sees a "Complete your profile" banner until they finish.`)) return;
    try { const r = await podiumopsPost('launchProfileCampaign', {}, session); showToast(r.already ? 'Already launched' : 'Campaign launched', 'success'); load(); }
    catch (e) { showToast(obError(e), 'error'); }
  }
  const people = d.people.filter(p => filter === 'all' || p.missing.length);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card title="Campaign" right={!d.launched_at ? <button style={primaryBtn} onClick={launch}><Megaphone size={13} /> Launch</button> : null}>
        <div style={{ fontSize: 13 }}>
          {d.launched_at ? <>Launched {fmtDate(d.launched_at)}. </> : <>Not launched — nobody sees the banner yet (joiners with an open onboarding do). </>}
          <b>{d.active - d.incomplete}</b> of <b>{d.active}</b> active profiles complete.
        </div>
      </Card>
      <Card title="Missing, by field">
        {!d.totals.length ? <div style={muted}>Nothing missing.</div> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {d.totals.map(t => <ToneBadge key={t.key} tone="warn" label={`${t.label}: ${t.missing}`} />)}
          </div>
        )}
      </Card>
      <Card title={`People (${people.length})`} right={
        <select style={{ ...inp, width: 160 }} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="incomplete">Incomplete only</option><option value="all">Everyone</option>
        </select>}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Person</th><th style={th}>Done</th><th style={th}>Missing</th></tr></thead>
          <tbody>
            {people.map(p => (
              <tr key={p.employee.id}>
                <td style={td}><b>{p.employee.full_name}</b><div style={muted}>{p.employee.employee_code} · {p.employee.department || '—'}</div></td>
                <td style={td}>{p.completion_pct}%</td>
                <td style={{ ...td, color: 'var(--text-2)' }}>{p.missing.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ChangeRequests({ session }) {
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    podiumopsGet('getProfileChangeRequests', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);
  if (d === false) return <div style={muted}>Could not load.</div>;
  if (!d) return <Spinner />;
  // One decision per change: PAN alone, or every pending bank field together. The revs prove which values HR saw.
  async function decide(g, decision) {
    let note = '';
    if (decision === 'rejected') { note = window.prompt('Reject — reason (the person sees it):', ''); if (note === null) return; }
    const k = `${g.employee_id}|${g.group}`;
    setBusy(k);
    try {
      await podiumopsPost('decideProfileChange', { employee_id: g.employee_id, group: g.group,
        items: g.items.map(i => ({ id: i.id, rev: i.rev })), decision, note }, session);
      showToast(decision === 'approved' ? 'Approved — applied' : 'Rejected', 'success'); load();
    } catch (e) { showToast(obError(e), 'error'); load(); }
    finally { setBusy(null); }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card title={`Awaiting approval (${d.pending.length})`}>
        {!d.pending.length ? <div style={muted}>Nothing waiting.</div> : d.pending.map(g => {
          const k = `${g.employee_id}|${g.group}`;
          return (
            <div key={k} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <b>{g.employee?.full_name}</b><span style={muted}>{g.employee?.employee_code} · {g.label} · asked {fmtDate(g.requested_at)}</span>
                <span style={{ flex: 1 }} />
                {g.own ? <span style={muted}>Your own — another HR person decides</span> : (
                  <>
                    <button style={smallBtn} disabled={busy === k} onClick={() => decide(g, 'rejected')}><X size={11} /> Reject</button>
                    <button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy === k} onClick={() => decide(g, 'approved')}><Check size={11} /> Approve {g.items.length > 1 ? 'all' : ''}</button>
                  </>
                )}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
                <thead><tr><th style={th}>Field</th><th style={th}>Current</th><th style={th}>New</th></tr></thead>
                <tbody>
                  {g.items.map(r => (
                    <tr key={r.id}>
                      <td style={td}>{CHANGE_FIELD_LABELS[r.field] || r.field}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{r.current_value || '—'}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{r.new_value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </Card>
      {d.decided.length > 0 && (
        <Card title="Recently decided">
          {d.decided.map(r => (
            <div key={r.id} style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
              <ToneBadge tone={r.status === 'approved' ? 'ok' : 'neutral'} label={r.status} /> {r.employee?.full_name} · {CHANGE_FIELD_LABELS[r.field] || r.field}
              <span style={muted}> · {fmtDate(r.decided_at)}{r.decision_note ? ` · ${r.decision_note}` : ''}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// XPayroll export: pick people (defaults to the open onboardings + recent joiners) → CSV with the sheet's headers.
function ExportTab({ board, session }) {
  const { showToast } = useToast();
  const people = [
    ...board.onboardings.map(o => o.employee),
    ...board.joiners_without.filter(e => !board.onboardings.some(o => o.employee.id === e.id)),
  ];
  const [sel, setSel] = useState(() => new Set(people.map(p => p.id)));
  const [busy, setBusy] = useState(false);
  const [pfBlank, setPfBlank] = useState([]);
  async function download() {
    setBusy(true);
    try {
      const r = await podiumopsGet('exportXPayroll', { employee_ids: [...sel].join(',') }, session);
      // .xlsx (exceljs — already the estate's xlsx library): the long / leading-zero digit columns (UAN, ESIC,
      // phone, bank account) are TEXT cells, so Excel / Sheets never drop zeros or turn them into 1.2E+17.
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Employee Data');
      ws.addRow(r.headers);
      ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
      for (const row of r.rows) ws.addRow(row.map((v, i) => (r.text_columns.includes(i) && v !== '' && v != null ? String(v) : v)));
      for (const i of r.text_columns) ws.getColumn(i + 1).numFmt = '@';
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = r.file_name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPfBlank(r.pf_blank || []);
      showToast(`Exported ${r.count}${r.pf_blank?.length ? ` — PF Y/N blank for ${r.pf_blank.length}, fill it in before uploading` : ''}`, r.pf_blank?.length ? 'warning' : 'success');
    } catch (e) { showToast(obError(e), 'error'); }
    finally { setBusy(false); }
  }
  const toggle = (id) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Card title="XPayroll onboarding sheet" right={<button style={primaryBtn} disabled={busy || !sel.size} onClick={download}><Download size={13} /> Download CSV ({sel.size})</button>}>
      <div style={{ ...muted, marginBottom: 8 }}>Columns match the XPayroll “Employee Data” sheet. The file carries CTC, bank and past-salary figures — each export is logged per person.</div>
      {pfBlank.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--warn-fg)', marginBottom: 8 }}>
          PF Y/N is blank (no accepted offer carried it) for: {pfBlank.map(p => p.full_name).join(', ')} — fill it in the sheet before uploading.
        </div>
      )}
      {!people.length ? <div style={muted}>No joiners in the last 90 days.</div> : people.map(p => (
        <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '4px 0' }}>
          <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
          <b>{p.full_name}</b> <span style={muted}>{p.employee_code} · joined {fmtDate(p.date_joined)}</span>
        </label>
      ))}
    </Card>
  );
}
