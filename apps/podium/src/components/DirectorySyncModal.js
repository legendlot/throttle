'use client';
import { useEffect, useMemo, useState } from 'react';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { X, RefreshCw, UserPlus, AlertTriangle, Ban, ArrowLeftRight, Eye, Upload } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';

// On-demand Google Directory sync. Two tabs:
// · From Google: review-and-confirm new joiners (import / ignore, dept/manager editable). X1: people suspended /
//   missing in Google are ALERTS only; an exit is started on the person's page (the worker refuses an exit list).
// · Google vs Podium (J1b D11): Podium is the source of truth for name, title, department, manager, code and
//   org unit, and pushes them to Google (never phones — they stay in Podium). Push is held while bulk_paused (0019). Per person × field diff, Preview (dry run) then Push in chunks of 8.
//   The old "moved / differing" review is gone: the worker refuses update / dismiss / baseline (podium_owns_these_fields).
export default function DirectorySyncModal({ session, onClose, onDone }) {
  const [tab, setTab] = useState('google');
  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal} role="dialog" aria-modal="true" aria-label="Google Directory">
        <div style={head}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><RefreshCw size={15} /> Google Directory</span>
          <button onClick={onClose} style={iconBtn}><X size={16} /></button>
        </div>
        <div style={tabBar}>
          <button style={tabBtn(tab === 'google')} onClick={() => setTab('google')}><UserPlus size={12} /> From Google</button>
          <button style={tabBtn(tab === 'diff')} onClick={() => setTab('diff')}><ArrowLeftRight size={12} /> Google vs Podium</button>
        </div>
        {tab === 'google'
          ? <FromGoogle session={session} onClose={onClose} onDone={onDone} />
          : <GoogleVsPodium session={session} onClose={onClose} />}
      </div>
    </div>
  );
}

function FromGoogle({ session, onClose, onDone }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);          // new candidates (editable)
  const [departed, setDeparted] = useState([]);  // exit_started_outside_podium alerts (read-only)
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await podiumopsGet('getDirectorySyncPreview', {}, session);
      setData(r);
      // `date_joined` starts EMPTY and is required — the mirror of the (former) exit-date rule.
      // Google knows when it created the account, never when the person started work, and an
      // employee with no joining date counts as employed in EVERY month the salary run has ever
      // covered. All 8 undated employees found on 2026-09-09 were created by this screen.
      // J1: an account Podium created for a hire who has not joined yet joins through Confirm joining on
      // the candidate page — never imported here (the worker refuses it too), so it starts with no action.
      setRows((r.new_candidates || []).map(c => ({
        ...c, action: c.origin === 'podium_awaiting_joining' ? 'none' : 'import', date_joined: '',
        department_id: c.suggested_department_id || '',
        manager_id: c.suggested_manager_id || '',
      })));
      // X1: alerts only — never exited from here (the S363 sync-day-date history is why exits moved to Podium).
      setDeparted(r.departed || []);
    } catch (e) {
      setError(e.message || 'Sync failed');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function setRow(email, patch) {
    setRows(prev => prev.map(r => (r.email === email ? { ...r, ...patch } : r)));
  }

  async function submit() {
    const create = rows.filter(r => r.action === 'import')
      .map(r => ({ email: r.email, date_joined: r.date_joined, department_id: r.department_id || null, manager_id: r.manager_id || null, job_title: r.job_title || null }));
    const ignore = rows.filter(r => r.action === 'ignore').map(r => r.email);
    const undatedJoins = rows.filter(r => r.action === 'import' && !r.date_joined);
    if (undatedJoins.length) {
      showToast(`Joining date required for ${undatedJoins.map(r => r.full_name).join(', ')}`, 'error');
      return;
    }
    if (!create.length && !ignore.length) { showToast('Nothing selected', 'error'); return; }
    if (create.length > 20) { showToast('Import at most 20 at a time', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await podiumopsPost('importDirectoryCandidates', { data: { create, ignore } }, session);
      const msg = [`${res.created?.length || 0} added`, `${res.ignored?.length || 0} ignored`].join(' · ');
      showToast(res.errors?.length ? `${msg} · ${res.errors.length} error(s)` : msg, res.errors?.length ? 'error' : 'success');
      onDone && onDone();
      onClose();
    } catch (e) { showToast(e.message || 'Import failed', 'error'); }
    finally { setSubmitting(false); }
  }

  const c = data?.counts;
  return (
    <>
        <div style={body}>
          {loading ? <div style={{ padding: 40 }}><Spinner /></div>
          : error ? (
            <div style={{ padding: 20 }}>
              <p style={{ color: 'var(--state-error-fg)', marginBottom: 6 }}>{error}</p>
              <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
                {error.includes('not_configured')
                  ? 'Google sync isn’t configured yet (the service-account secrets aren’t set on the worker).'
                  : 'Check the worker logs and retry.'}
              </p>
              <button style={btnSecondary} onClick={load}>Retry</button>
            </div>
          ) : (
            <>
              <div style={summary}>
                <b>{c?.google_total ?? 0}</b> in Google · <b>{c?.excluded_ou ?? 0}</b> shared (skipped) ·
                <b style={{ color: 'var(--podium-accent)' }}> {c?.new ?? 0}</b> new · <b>{c?.departed ?? 0}</b> departed
              </div>

              {rows.length === 0 && departed.length === 0 && (
                <div style={{ padding: 20, color: 'var(--text-3)' }}>Everyone in Google is already in Podium. Nothing to import. Department, manager and org unit differences are on the Google vs Podium tab.</div>
              )}

              {rows.length > 0 && (
                <>
                  <div style={sectionTitle}><UserPlus size={13} /> New people ({rows.length})</div>
                  <table style={table}>
                    <thead><tr>
                      <th style={th}>Import</th><th style={th}>Name / email</th><th style={th}>Joining date *</th>
                      <th style={th}>Google OU</th>
                      <th style={th}>Department</th><th style={th}>Manager</th><th style={th}>Login</th>
                    </tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.email} style={{ opacity: r.action === 'ignore' ? 0.45 : 1 }}>
                          <td style={td}>
                            {r.origin === 'podium_awaiting_joining' ? (
                              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>joins via<br />hiring</span>
                            ) : (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button title="Import as person" style={pill(r.action === 'import', 'var(--podium-accent)', '#1f1f1f')} onClick={() => setRow(r.email, { action: 'import' })}><UserPlus size={12} /></button>
                                <button title="Ignore (never show again)" style={pill(r.action === 'ignore', 'var(--surface-3)', 'var(--text-2)')} onClick={() => setRow(r.email, { action: 'ignore' })}><Ban size={12} /></button>
                              </div>
                            )}
                          </td>
                          <td style={td}>
                            <div style={{ fontWeight: 600 }}>{r.full_name}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{r.email}</div>
                            <div style={{ fontSize: 10.5, color: r.origin === 'podium_awaiting_joining' ? 'var(--podium-accent)' : 'var(--text-3)', marginTop: 2 }}>{ORIGIN_LABEL[r.origin] || ORIGIN_LABEL.outside}</div>
                          </td>
                          {/* Required, empty by default. NO `max`: unlike an exit date, a future
                              joining date is legitimate — people are onboarded before they start. */}
                          <td style={td}>
                            <input
                              type="date"
                              value={r.date_joined}
                              disabled={r.action !== 'import'}
                              onChange={e => setRow(r.email, { date_joined: e.target.value })}
                              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '4px 6px',
                                       border: `1px solid ${r.action === 'import' && !r.date_joined ? 'var(--state-warning-fg)' : 'var(--border)'}`,
                                       borderRadius: 4, background: r.action === 'import' ? 'var(--surface)' : 'transparent',
                                       color: 'var(--text-1)', opacity: r.action === 'import' ? 1 : 0.4 }}
                            />
                          </td>
                          <td style={{ ...td, fontSize: 11, color: 'var(--text-3)' }}>{r.org_unit || '—'}</td>
                          <td style={td}>
                            <Combobox value={r.department_id || ''} disabled={r.action !== 'import'} onChange={v => setRow(r.email, { department_id: v })}
                              style={comboCell} inputStyle={comboCellInp} placeholder="Search…" portal
                              options={(data.departments || []).map(d => ({ value: d.id, label: d.name }))} />
                          </td>
                          <td style={td}>
                            <Combobox value={r.manager_id || ''} disabled={r.action !== 'import'} onChange={v => setRow(r.email, { manager_id: v })}
                              style={comboCell} inputStyle={comboCellInp} placeholder="Search…" portal
                              options={(data.managers || []).map(m => ({ value: m.id, label: m.full_name }))} />
                          </td>
                          <td style={{ ...td, fontSize: 11 }}>{r.has_login ? <span style={{ color: 'var(--state-success-fg)' }}>linked</span> : <span style={{ color: 'var(--text-3)' }}>none</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {departed.length > 0 && (
                <>
                  <div style={{ ...sectionTitle, marginTop: 16, color: 'var(--state-error-fg)' }}><AlertTriangle size={13} /> Exit started outside Podium ({departed.length})</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6, lineHeight: 1.5 }}>
                    These people are active in Podium but their Google account is suspended or gone. The sync never
                    exits anyone — an exit is recorded in Podium with its reason, checklist and last working day.
                    Open the person and use <strong>Start exit</strong>.
                  </div>
                  <table style={table}>
                    <thead><tr><th style={th}>Name / email</th><th style={th}>Google</th><th style={th}>In Podium</th></tr></thead>
                    <tbody>
                      {departed.map(d => (
                        <tr key={d.id}>
                          <td style={td}><div style={{ fontWeight: 600 }}>{d.full_name}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{d.work_email}</div></td>
                          <td style={{ ...td, fontSize: 12, color: 'var(--state-error-fg)' }}>{d.reason}</td>
                          <td style={{ ...td, fontSize: 12 }}>
                            {d.exit_open
                              ? <span style={{ color: 'var(--text-3)' }}>Exit already open</span>
                              : <a href={`/people/detail/?id=${d.id}`} style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>Start the exit here →</a>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>

        <div style={foot}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
          {!loading && !error && (
            <button style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }} onClick={submit} disabled={submitting}>
              {submitting ? 'Applying…' : 'Apply'}
            </button>
          )}
        </div>
    </>
  );
}

// ── Google vs Podium (J1b D11) ───────────────────────────────────────────────
const FIELD_LABEL = { name: 'Name', title: 'Job title', department: 'Department', manager: 'Manager',
  employee_code: 'Employee code', org_unit: 'Org unit' };
const STATE_LABEL = { differs: 'Differs', changed_in_google: 'Changed in Google', podium_blank: 'Blank in Podium', equal: 'Same' };
const SKIP_LABEL = {
  founder_or_super_admin: 'Founder or super-admin (never synced)', directory_ignored: 'On the ignore list', no_google_account: 'No Google account',
  alias_mismatch: 'Work email is an alias in Google', suspended: 'Suspended in Google', excluded_ou: 'In an excluded org unit',
  target_ou_excluded: 'Chosen org unit is excluded', target_ou_unknown: 'Chosen org unit not in Google', no_work_email: 'No work email',
  status_out_of_scope: 'Status not synced', exited: 'Exited', not_found: 'Not found',
};
const RESULT_LABEL = { would_push: 'Would push', no_change: 'No change', skipped: 'Skipped', failed: 'Failed', ok: 'Pushed', pending: 'Pushed, more pending',
  in_progress: 'In progress elsewhere', stale_preview: 'Changed since the preview, not pushed' };

function showVal(field, v, state) {
  if (field === 'manager' && state === 'podium_blank') return 'manager has no work email';
  if (field === 'name') {
    if (!v) return 'blank';
    return v.givenName === v.familyName ? v.givenName : `${v.givenName} ${v.familyName}`;
  }
  if (field === 'manager' && v === null) return 'no manager';
  return v || 'blank';
}

// Group the picked person × field cells into calls: people with the same field set share a call, ≤ chunk per call.
function planCalls(picked, chunk) {
  const groups = new Map();
  for (const [id, fields] of picked) {
    if (!fields.length) continue;
    const key = [...fields].sort().join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const calls = [];
  for (const [key, ids] of groups) for (let i = 0; i < ids.length; i += chunk) calls.push({ fields: key.split(','), employee_ids: ids.slice(i, i + chunk) });
  return calls;
}

function GoogleVsPodium({ session, onClose }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [pick, setPick] = useState({});          // `${id}:${field}` → true
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState(null);  // { key, results }
  const [busy, setBusy] = useState(null);        // 'preview' | 'push' | null
  const [progress, setProgress] = useState('');
  const [notPushed, setNotPushed] = useState([]); // after a Push: stale / failed / in progress rows, and org units skipped

  async function load() {
    setLoading(true); setError(null); setPreview(null);
    try {
      const r = await podiumopsGet('getGoogleDiff', {}, session);
      setData(r);
      // Podium is the truth: a plain difference starts ticked. "Changed in Google" (someone edited Google after our
      // last push) starts unticked, so HR looks at it before Podium's value overwrites it.
      const p = {};
      for (const person of r.people || []) for (const f of r.fields || []) if (person.fields[f]?.state === 'differs') p[`${person.id}:${f}`] = true;
      setPick(p);
    } catch (e) { setError(e.message || 'Could not load the diff'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const picked = useMemo(() => {
    const m = new Map();
    for (const [k, on] of Object.entries(pick)) {
      if (!on) continue;
      const [id, f] = k.split(':');
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(f);
    }
    return m;
  }, [pick]);
  const pickKey = useMemo(() => [...picked].map(([id, fs]) => `${id}:${[...fs].sort().join(',')}`).sort().join('|'), [picked]);
  const chunk = data?.push_chunk || 8;
  const cellCount = [...picked.values()].reduce((n, fs) => n + fs.length, 0);

  async function run(dryRun) {
    // Push is bound to the preview and is one-shot: only the people the preview says would change are sent, each with
    // the hash of the exact body previewed. The worker refuses anyone whose body has changed since (stale_preview,
    // 409; the others in that batch are still pushed), and a failed push is NOT retried automatically.
    const hashOf = Object.fromEntries((preview?.results || []).filter(r => r.status === 'would_push' && r.hash).map(r => [r.employee_id, r.hash]));
    const sendPick = dryRun ? picked : new Map([...picked].filter(([id]) => hashOf[id]));
    const calls = planCalls(sendPick, chunk);
    if (!calls.length) { showToast(dryRun ? 'Tick at least one field' : 'The preview has nothing to push', 'error'); return; }
    const sendCells = [...sendPick.values()].reduce((n, fs) => n + fs.length, 0);
    if (!dryRun && !window.confirm(`Push Podium's values to Google for ${sendPick.size} ${sendPick.size === 1 ? 'person' : 'people'} (${sendCells} fields)?`)) return;
    setBusy(dryRun ? 'preview' : 'push');
    setNotPushed([]);
    const results = [];
    try {
      for (let i = 0; i < calls.length; i++) {
        setProgress(`${dryRun ? 'Previewing' : 'Pushing'} batch ${i + 1} of ${calls.length}`);
        const data = { ...calls[i], dry_run: dryRun };
        if (!dryRun) data.preview_hashes = Object.fromEntries(calls[i].employee_ids.map(id => [id, hashOf[id]]));
        try {
          const r = await podiumopsPost('pushGoogleFields', { data }, session);
          results.push(...(r.results || []));
        } catch (e) {
          if (e.body?.error !== 'stale_preview') throw e;
          results.push(...(e.body.results || []));
        }
      }
      if (dryRun) setPreview({ key: pickKey, results });
      else {
        const n = (s) => results.filter(x => x.status === s).length;
        const msg = `${n('ok') + n('pending')} pushed · ${n('skipped')} skipped · ${n('failed')} failed${n('stale_preview') ? ` · ${n('stale_preview')} changed since the preview` : ''}`;
        showToast(msg, n('failed') || n('stale_preview') ? 'error' : 'success');
        await load();
        setPreview(null);   // a preview is spent once pushed; preview again for anything left
        setNotPushed(results.filter(x => ['failed', 'stale_preview', 'in_progress'].includes(x.status) || Object.keys(x.field_skips || {}).length));
      }
    } catch (e) { showToast(e.message || (dryRun ? 'Preview failed' : 'Push failed'), 'error'); }
    finally { setBusy(null); setProgress(''); }
  }

  const people = (data?.people || []).filter(p => showAll || p.differing.length || (data.fields || []).some(f => pick[`${p.id}:${f}`]));
  const previewFresh = preview && preview.key === pickKey;
  const toggle = (id, f) => setPick(prev => ({ ...prev, [`${id}:${f}`]: !prev[`${id}:${f}`] }));

  return (
    <>
      <div style={body}>
        {loading ? <div style={{ padding: 40 }}><Spinner /></div>
        : error ? (
          <div style={{ padding: 20 }}>
            <p style={{ color: 'var(--state-error-fg)', marginBottom: 6 }}>{error}</p>
            <button style={btnSecondary} onClick={load}>Retry</button>
          </div>
        ) : (
          <>
            <div style={summary}>
              <b>{data.counts.in_scope}</b> synced · <b style={{ color: 'var(--podium-accent)' }}>{data.counts.differing}</b> with differences ·
              <b> {data.counts.skipped}</b> not synced · <b>{cellCount}</b> fields ticked
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
              Podium is the source of truth. Ticked fields get Podium&apos;s value in Google. <b>Changed in Google</b> = someone edited it in Google after
              Podium last pushed it; check it before ticking. A field blank in Podium is never pushed (Google keeps its value), except the manager:
              no manager in Podium removes Google&apos;s. Preview shows the exact change; Push sends it, {chunk} people per batch.
            </div>
            {notPushed.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 10, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Not everything was pushed. A failed push is not retried automatically: preview and push again.</div>
                {notPushed.map(x => {
                  const pp = (data.people || []).find(q => q.id === x.employee_id);   // push results carry ids only
                  const who = pp?.full_name || pp?.work_email || x.employee_id;
                  const skips = Object.values(x.field_skips || {});
                  const why = x.status === 'stale_preview' ? 'Google or Podium changed after the preview'
                    : x.status === 'failed' ? `Failed${x.error ? `: ${x.error}` : ''}`
                    : x.status === 'in_progress' ? 'Being synced right now, try again in a minute'
                    : `Pushed, but the org unit was not moved: ${skips.map(r => SKIP_LABEL[r] || r).join(', ')}`;
                  return <div key={x.employee_id}>{who}: {why}</div>;
                })}
              </div>
            )}
            <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show people with no differences
            </label>

            {people.length === 0 ? (
              <div style={{ padding: 20, color: 'var(--text-3)' }}>Google already matches Podium for everyone synced.</div>
            ) : (
              <table style={table}>
                <thead><tr><th style={th}>Person</th><th style={th}>Field</th><th style={th}>Podium</th><th style={th}>Google</th><th style={th}>State</th><th style={th}>Push</th></tr></thead>
                <tbody>
                  {people.map(p => {
                    const fs = (data.fields || []).filter(f => showAll || p.fields[f].state !== 'equal');
                    return fs.map((f, i) => {
                      const cell = p.fields[f];
                      const pushable = cell.state === 'differs' || cell.state === 'changed_in_google';
                      return (
                        <tr key={`${p.id}:${f}`}>
                          {i === 0 && (
                            <td style={td} rowSpan={fs.length}>
                              <div style={{ fontWeight: 600 }}>{p.full_name}</div>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{p.work_email}</div>
                              {p.sync?.status === 'failed' && <div style={{ fontSize: 10.5, color: 'var(--state-error-fg)', marginTop: 2 }}>Last push failed: {p.sync.last_error}</div>}
                            </td>
                          )}
                          <td style={{ ...td, fontSize: 12 }}>{FIELD_LABEL[f]}</td>
                          <td style={{ ...td, fontSize: 12 }}>{showVal(f, cell.podium, cell.state)}</td>
                          <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{showVal(f, cell.google)}</td>
                          <td style={{ ...td, fontSize: 11, color: cell.state === 'changed_in_google' ? 'var(--state-warning-fg)' : 'var(--text-3)' }}>{STATE_LABEL[cell.state]}</td>
                          <td style={td}>{pushable && <input type="checkbox" checked={!!pick[`${p.id}:${f}`]} onChange={() => toggle(p.id, f)} aria-label={`Push ${FIELD_LABEL[f]} for ${p.full_name}`} />}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            )}

            {previewFresh && (
              <>
                <div style={{ ...sectionTitle, marginTop: 16 }}><Eye size={13} /> Preview: what Push would send ({preview.results.length})</div>
                <table style={table}>
                  <thead><tr><th style={th}>Person</th><th style={th}>Result</th><th style={th}>Google request</th></tr></thead>
                  <tbody>
                    {preview.results.map(r => (
                      <tr key={r.employee_id}>
                        <td style={td}><div style={{ fontWeight: 600 }}>{r.full_name || r.employee_id}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{r.work_email}</div></td>
                        <td style={{ ...td, fontSize: 12 }}>{RESULT_LABEL[r.status] || r.status}{r.skip_reason ? `: ${SKIP_LABEL[r.skip_reason] || r.skip_reason}` : ''}{r.error ? `: ${r.error}` : ''}</td>
                        <td style={td}>{r.body ? <pre style={pre}>{JSON.stringify(r.body, null, 2)}</pre> : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>nothing to send</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {data.skipped?.length > 0 && (
              <details style={{ marginTop: 14 }}>
                <summary style={{ ...sectionTitle, cursor: 'pointer' }}><Ban size={13} /> Not synced ({data.skipped.length})</summary>
                <table style={table}>
                  <tbody>
                    {data.skipped.map(x => (
                      <tr key={x.id}><td style={td}>{x.full_name}<div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{x.work_email || 'no work email'}</div></td>
                        <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{SKIP_LABEL[x.reason] || x.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </>
        )}
      </div>
      <div style={foot}>
        {progress && <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 'auto', alignSelf: 'center' }}>{progress}</span>}
        <button style={btnSecondary} onClick={onClose} disabled={!!busy}>Close</button>
        {!loading && !error && data?.can_push && (
          <>
            <button style={{ ...btnSecondary, opacity: busy ? 0.6 : 1 }} onClick={() => run(true)} disabled={!!busy || !cellCount}>
              <Eye size={12} /> {busy === 'preview' ? 'Previewing…' : 'Preview'}
            </button>
            {data.bulk_paused ? (
              <span style={{ fontSize: 12, color: 'var(--text-3)', alignSelf: 'center' }}>Bulk push paused while Podium’s data is checked.</span>
            ) : (
              <button style={{ ...btnPrimary, opacity: busy || !previewFresh ? 0.6 : 1 }} onClick={() => run(false)} disabled={!!busy || !previewFresh}
                title={previewFresh ? '' : 'Preview the ticked fields first'}>
                <Upload size={12} /> {busy === 'push' ? 'Pushing…' : 'Push to Google'}
              </button>
            )}
          </>
        )}
        {!loading && !error && data && !data.can_push && (
          <span style={{ fontSize: 12, color: 'var(--text-3)', alignSelf: 'center' }}>Only a Google admin can push.</span>
        )}
      </div>
    </>
  );
}

// J1 (wording only): where a new Google account came from.
const ORIGIN_LABEL = {
  podium_awaiting_joining: 'Created by Podium — awaiting joining',
  podium_override: 'Created by Podium without hiring',
  outside: 'Created outside Podium',
};

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflow: 'auto' };
const modal = { width: 'min(940px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', maxHeight: '90vh' };
const head = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14, color: 'var(--text-1)' };
const body = { padding: '12px 16px', overflow: 'auto', flex: 1 };
const foot = { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border)' };
const summary = { fontSize: 13, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12 };
const sectionTitle = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', margin: '6px 0' };
const table = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '7px 8px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '7px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
const sel = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 12, minWidth: 130, maxWidth: 170 };
const comboCell = { minWidth: 130, maxWidth: 180 };
const comboCellInp = { fontSize: 12, padding: '4px 6px' };
const tabBar = { display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border)' };
const tabBtn = (on) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none',
  borderBottom: `2px solid ${on ? 'var(--podium-accent)' : 'transparent'}`, color: on ? 'var(--text-1)' : 'var(--text-3)',
  padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginBottom: -1 });
const pre = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 420, color: 'var(--text-2)' };
const iconBtn = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'inline-flex' };
const btnBase = { borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnPrimary = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
function pill(active, onBg, onFg) {
  return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 22,
    background: active ? onBg : 'var(--surface-2)', color: active ? onFg : 'var(--text-3)',
    border: `1px solid ${active ? onBg : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
}
