'use client';
import { useEffect, useState } from 'react';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { X, RefreshCw, UserPlus, UserMinus, Ban, ArrowLeftRight, Check } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';

// On-demand Google Directory sync — review-and-confirm. Proposes new joiners +
// departures; you pick which to import (dept/manager editable), ignore, or exit.
export default function DirectorySyncModal({ session, onClose, onDone }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);          // new candidates (editable)
  const [departed, setDeparted] = useState([]);  // {…, exit}
  const [moves, setMoves] = useState([]);        // existing people whose Google signal changed
  const [baseline, setBaseline] = useState([]);  // nothing to review — just record the OU we saw
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await podiumopsGet('getDirectorySyncPreview', {}, session);
      setData(r);
      setRows((r.new_candidates || []).map(c => ({
        ...c, action: 'import',
        department_id: c.suggested_department_id || '',
        manager_id: c.suggested_manager_id || '',
      })));
      setDeparted((r.departed || []).map(d => ({ ...d, exit: false })));
      // A 'moved' row (Google's OU actually changed) defaults to Update with Google's
      // suggestion pre-filled. A 'differs' row defaults to NO action — Podium is finer
      // grained than Google, so a standing disagreement is usually Podium being right.
      setBaseline(r.baseline || []);
      setMoves((r.changed || []).map(c => ({
        ...c,
        action: c.tier === 'moved' ? 'update' : 'none',
        department_id: c.dept_suggested_id || c.dept_current_id || '',
        manager_id: c.mgr_suggested_id || c.mgr_current_id || '',
      })));
    } catch (e) {
      setError(e.message || 'Sync failed');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function setRow(email, patch) {
    setRows(prev => prev.map(r => (r.email === email ? { ...r, ...patch } : r)));
  }
  function setMove(id, patch) {
    setMoves(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function submit() {
    const create = rows.filter(r => r.action === 'import')
      .map(r => ({ email: r.email, department_id: r.department_id || null, manager_id: r.manager_id || null, job_title: r.job_title || null }));
    const ignore = rows.filter(r => r.action === 'ignore').map(r => r.email);
    const exit = departed.filter(d => d.exit).map(d => d.work_email);
    const update = moves.filter(m => m.action === 'update')
      .map(m => ({ id: m.id, department_id: m.department_id || null, manager_id: m.manager_id || null, org_unit: m.org_unit }));
    const dismiss = moves.filter(m => m.action === 'dismiss').map(m => ({ id: m.id, org_unit: m.org_unit }));
    if (!create.length && !ignore.length && !exit.length && !update.length && !dismiss.length && !baseline.length) { showToast('Nothing selected', 'error'); return; }
    if (create.length > 20) { showToast('Import at most 20 at a time', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await podiumopsPost('importDirectoryCandidates', { data: { create, exit, ignore, update, dismiss, baseline } }, session);
      const parts = [`${res.created?.length || 0} added`, `${res.exited?.length || 0} exited`, `${res.ignored?.length || 0} ignored`];
      if (update.length || dismiss.length) parts.push(`${res.updated?.length || 0} updated`, `${res.dismissed?.length || 0} dismissed`);
      if (res.baselined) parts.push(`${res.baselined} recorded`);
      // An exit silently moves reporting lines, so say so rather than let it pass unseen.
      const moved = (res.reassigned || []).reduce((n, x) => n + (x.people?.length || 0), 0);
      if (moved) parts.push(`${moved} report${moved === 1 ? '' : 's'} reassigned`);
      const needs = (res.reassign_needs_attention || []).reduce((n, x) => n + (x.people?.length || 0), 0);
      if (needs) parts.push(`${needs} need a manager`);
      const msg = parts.join(' · ');
      showToast(res.errors?.length ? `${msg} · ${res.errors.length} error(s)` : msg, res.errors?.length ? 'error' : 'success');
      onDone && onDone();
      onClose();
    } catch (e) { showToast(e.message || 'Import failed', 'error'); }
    finally { setSubmitting(false); }
  }

  const c = data?.counts;
  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={head}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><RefreshCw size={15} /> Sync from Google Directory</span>
          <button onClick={onClose} style={iconBtn}><X size={16} /></button>
        </div>

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
                <b style={{ color: 'var(--podium-accent)' }}> {c?.new ?? 0}</b> new · <b>{c?.departed ?? 0}</b> departed ·
                <b style={{ color: 'var(--podium-accent)' }}> {c?.moved ?? 0}</b> moved · <b>{c?.differs ?? 0}</b> differing
              </div>

              {rows.length === 0 && departed.length === 0 && moves.length === 0 && (
                <div style={{ padding: 20, color: 'var(--text-3)' }}>Everyone in Google is already in Podium, in the same department, under the same manager. Nothing to review.</div>
              )}

              {baseline.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 10, lineHeight: 1.5 }}>
                  Applying will also record the current Google org unit for <b>{baseline.length}</b> {baseline.length === 1 ? 'person who matches' : 'people who match'} Podium already.
                  This writes nothing but that org unit — no department, no manager, nobody moves. It is what lets a future change be recognised as a real move rather than a disagreement.
                </div>
              )}

              {rows.length > 0 && (
                <>
                  <div style={sectionTitle}><UserPlus size={13} /> New people ({rows.length})</div>
                  <table style={table}>
                    <thead><tr>
                      <th style={th}>Import</th><th style={th}>Name / email</th><th style={th}>Google OU</th>
                      <th style={th}>Department</th><th style={th}>Manager</th><th style={th}>Login</th>
                    </tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.email} style={{ opacity: r.action === 'ignore' ? 0.45 : 1 }}>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button title="Import as person" style={pill(r.action === 'import', 'var(--podium-accent)', '#1f1f1f')} onClick={() => setRow(r.email, { action: 'import' })}><UserPlus size={12} /></button>
                              <button title="Ignore (never show again)" style={pill(r.action === 'ignore', 'var(--surface-3)', 'var(--text-2)')} onClick={() => setRow(r.email, { action: 'ignore' })}><Ban size={12} /></button>
                            </div>
                          </td>
                          <td style={td}>
                            <div style={{ fontWeight: 600 }}>{r.full_name}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{r.email}</div>
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

              {moves.length > 0 && (
                <>
                  <div style={{ ...sectionTitle, marginTop: 16 }}><ArrowLeftRight size={13} /> Moved / differing ({moves.length})</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
                    <b style={{ color: 'var(--podium-accent)' }}>Moved</b> = this person’s Google org unit actually changed since the last sync — a real move, pre-filled and set to update.
                    <b> Differing</b> = Google simply disagrees with Podium; Podium’s departments are finer-grained than Google’s, so this is usually Podium being right. Those default to no action —
                    set the correct department/manager yourself, or dismiss to stop it being reported again.
                  </div>
                  <table style={table}>
                    <thead><tr>
                      <th style={th}>Action</th><th style={th}>Person</th><th style={th}>What changed</th>
                      <th style={th}>Department</th><th style={th}>Manager</th>
                    </tr></thead>
                    <tbody>
                      {moves.map(m => (
                        <tr key={m.id} style={{ opacity: m.action === 'dismiss' ? 0.45 : 1 }}>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button title="Apply the department / manager shown" style={pill(m.action === 'update', 'var(--podium-accent)', '#1f1f1f')} onClick={() => setMove(m.id, { action: 'update' })}><Check size={12} /></button>
                              <button title="Leave Podium as it is (and stop reporting this)" style={pill(m.action === 'dismiss', 'var(--surface-3)', 'var(--text-2)')} onClick={() => setMove(m.id, { action: 'dismiss' })}><Ban size={12} /></button>
                            </div>
                            {m.action === 'none' && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>no action</div>}
                          </td>
                          <td style={td}>
                            <div style={{ fontWeight: 600 }}>{m.full_name}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{m.email}</div>
                          </td>
                          <td style={{ ...td, fontSize: 11, color: 'var(--text-3)', maxWidth: 240 }}>
                            <span style={{
                              display: 'inline-block', marginBottom: 3, padding: '1px 6px', borderRadius: 3, fontSize: 9.5,
                              fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                              background: m.tier === 'moved' ? 'var(--podium-accent)' : 'var(--surface-3)',
                              color: m.tier === 'moved' ? '#1f1f1f' : 'var(--text-2)',
                            }}>{m.tier === 'moved' ? 'Moved' : 'Differs'}</span>
                            {(m.reasons || []).map((x, i) => <div key={i}>{x}</div>)}
                            <div style={{ marginTop: 3 }}>Now in Podium: {m.dept_current_name || '—'} · {m.mgr_current_name || 'no manager'}</div>
                          </td>
                          <td style={td}>
                            <Combobox value={m.department_id || ''} disabled={m.action === 'dismiss'} onChange={v => setMove(m.id, { department_id: v, action: m.action === 'none' ? 'update' : m.action })}
                              style={comboCell} inputStyle={comboCellInp} placeholder="Search…" portal
                              options={(data.departments || []).map(d => ({ value: d.id, label: d.name }))} />
                          </td>
                          <td style={td}>
                            <Combobox value={m.manager_id || ''} disabled={m.action === 'dismiss'} onChange={v => setMove(m.id, { manager_id: v, action: m.action === 'none' ? 'update' : m.action })}
                              style={comboCell} inputStyle={comboCellInp} placeholder="Search…" portal
                              options={(data.managers || []).filter(x => x.id !== m.id).map(x => ({ value: x.id, label: x.full_name }))} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {departed.length > 0 && (
                <>
                  <div style={{ ...sectionTitle, marginTop: 16 }}><UserMinus size={13} /> Possibly departed ({departed.length})</div>
                  <table style={table}>
                    <thead><tr><th style={th}>Mark exited</th><th style={th}>Name / email</th><th style={th}>Why</th></tr></thead>
                    <tbody>
                      {departed.map((d, i) => (
                        <tr key={d.id}>
                          <td style={td}><input type="checkbox" checked={d.exit} onChange={e => setDeparted(prev => prev.map((x, j) => j === i ? { ...x, exit: e.target.checked } : x))} /></td>
                          <td style={td}><div style={{ fontWeight: 600 }}>{d.full_name}</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{d.work_email}</div></td>
                          <td style={{ ...td, fontSize: 12, color: 'var(--state-warning-fg)' }}>{d.reason}</td>
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
      </div>
    </div>
  );
}

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
const iconBtn = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'inline-flex' };
const btnBase = { borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnPrimary = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
function pill(active, onBg, onFg) {
  return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 22,
    background: active ? onBg : 'var(--surface-2)', color: active ? onFg : 'var(--text-3)',
    border: `1px solid ${active ? onBg : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
}
