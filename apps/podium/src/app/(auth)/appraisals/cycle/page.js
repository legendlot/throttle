'use client';
// Appraisal cycle OVERVIEW (super admins; spec docs/superpowers/specs/2026-09-22-podium-appraisal-overview.md):
// reconciliation + chasing (progress strip, everyone grouped by manager or department with pending
// counts), current → new CTC per person, bulk accept / lock-in, and the company-level budget panel.
// Per-person calibration lives on /appraisals/detail.
import { Suspense, useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, Check } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS, ratingColor, fmtMonths } from '../../../../lib/appraisals.js';
import { fmtDate, fmtMoney } from '../../../../lib/format.js';

export default function Page() {
  return <Suspense fallback={<Spinner />}><CyclePage /></Suspense>;
}

const FILTERS = [
  ['all', 'All', () => true],
  ['self', 'Self pending', a => !a.self_submitted_at && !a.self_review_waived_at],
  ['mgr', 'Manager pending', a => !a.manager_submitted_at],
  ['cal', 'To calibrate', a => a.manager_submitted_at && !a.final_rating],
  ['ready', 'Ready to lock', a => readyToLock(a)],
  ['locked', 'Locked', a => !!a.comp_locked_at],
];
function readyToLock(a) {
  return !a._own && !a.comp_locked_at && !!a.final_rating && (a.calibrated_increment_pct != null || a.calibrated_bonus != null);
}

function CyclePage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [ov, setOv] = useState(null);          // {cycle, counts, comp, appraisals, can_comp}
  const [enroll, setEnroll] = useState(null);  // enrollment preview rows or null
  const [busy, setBusy] = useState(false);
  const [groupBy, setGroupBy] = useState('manager');
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(() => new Set());

  const load = useCallback(async () => {
    if (!session || !id) return;
    try { setOv(await podiumopsGet('getCycleOverview', { cycle_id: id }, session)); }
    catch (e) { showToast(e.message || 'Failed to load', 'error'); }
  }, [session, id, showToast]);
  useEffect(() => { load(); }, [load]);

  async function post(action, data, msg) {
    setBusy(true);
    try { const r = await podiumopsPost(action, { data }, session); showToast(typeof msg === 'function' ? msg(r) : msg, 'success'); await load(); return r; }
    catch (e) { showToast(e.message || 'Failed', 'error'); return null; } finally { setBusy(false); }
  }
  const setStatus = (status) => post('setCycleStatus', { cycle_id: id, status }, 'Updated');
  async function openEnroll() {
    try { const r = await podiumopsGet('getEnrollmentPreview', { cycle_id: id }, session);
      setEnroll(r.candidates.map(c => ({ ...c, pick: c.eligibility === 'eligible' && !c.already_enrolled }))); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function doEnroll() {
    const ids = enroll.filter(c => c.pick && !c.already_enrolled).map(c => c.employee_id);
    if (!ids.length) { showToast('No one selected', 'error'); return; }
    const r = await post('enrollAppraisalCycle', { cycle_id: id, employee_ids: ids }, x => `Enrolled ${x.enrolled}`);
    if (r) setEnroll(null);
  }
  async function shareAll() {
    const ids = ov.appraisals.filter(a => a.final_rating && a.status !== 'acknowledged' && a.status !== 'shared').map(a => a.id);
    if (!ids.length) { showToast('Nothing finalized to share', 'error'); return; }
    if (!window.confirm(`Share ${ids.length} finalized result(s) with the employees?`)) return;
    post('shareAppraisal', { appraisal_ids: ids }, r => `Shared ${r.shared}`);
  }
  async function acceptSelected() {
    const ids = [...sel];
    if (!window.confirm(`Copy the manager's increment + bonus into the calibrated values for ${ids.length} selected (unlocked ones with a submitted recommendation)?`)) return;
    const r = await post('acceptManagerRecommendation', { appraisal_ids: ids }, x => `Accepted ${x.accepted}${x.skipped ? ` · ${x.skipped} skipped (no recommendation / locked)` : ''}`);
    if (r) setSel(new Set());
  }
  async function lockSelected(ids) {
    const rows = ov.appraisals.filter(a => ids.includes(a.id));
    const cost = rows.reduce((s, a) => s + ((a.new_ctc ?? 0) - (a.current_ctc ?? 0)) + Number(a.calibrated_bonus || 0), 0);
    if (!window.confirm(`Lock in ${ids.length} appraisal(s)? This writes each calibrated increment + one-time bonus to the compensation record permanently${ov.can_comp ? ` (≈ ${fmtMoney(cost)} this cycle)` : ''}.`)) return;
    const r = await post('lockAppraisalComp', { appraisal_ids: ids }, x => `Locked ${x.locked}${x.skipped?.length ? ` · ${x.skipped.length} skipped` : ''}`);
    if (r) {
      setSel(new Set());
      if (r.skipped?.length) window.alert('Not locked:\n' + r.skipped.map(s => `• ${s.name} — ${s.reason}`).join('\n'));
    }
  }

  const rows = ov?.appraisals || [];
  const filtered = useMemo(() => rows.filter((FILTERS.find(f => f[0] === filter) || FILTERS[0])[2]), [rows, filter]);
  const groups = useMemo(() => groupRows(filtered, groupBy), [filtered, groupBy]);

  if (perms && !perms.podium_super_admin) return <div style={{ color: 'var(--text-3)' }}>Appraisal cycles are restricted to super admins.</div>;
  if (!ov) return <Spinner />;
  const c = ov.cycle, k = ov.counts;
  const readyIds = rows.filter(readyToLock).map(a => a.id);
  const selReady = [...sel].filter(x => readyIds.includes(x));
  const toggle = (rid) => setSel(prev => { const n = new Set(prev); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  const toggleMany = (ids, on) => setSel(prev => { const n = new Set(prev); ids.forEach(x => (on ? n.add(x) : n.delete(x))); return n; });

  return (
    <div>
      <style>{`
        .ov-layout { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 16px; align-items: start; }
        .ov-side { position: sticky; top: 12px; display: flex; flex-direction: column; gap: 12px; }
        @media (max-width: 1100px) { .ov-layout { grid-template-columns: minmax(0, 1fr); } .ov-side { position: static; } }
        .ov-row:hover { background: var(--surface-2); }
      `}</style>
      <button onClick={() => router.push('/appraisals')} style={back}>← All cycles</button>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', margin: '8px 0 14px' }}>
        <div>
          <h1 style={h1}>{c.name} <span style={badge(c.status)}>{CYCLE_STATUS[c.status]}</span></h1>
          <p style={sub}>Appraisal date {fmtDate(c.appraisal_date)} · window {fmtDate(c.period_start)}→{fmtDate(c.period_end)} · eligibility cutoff {fmtDate(c.eligibility_cutoff_date)}</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {c.status === 'draft' && <button style={btnP} disabled={busy} onClick={() => setStatus('active')}>Activate (open reviews)</button>}
          {c.status === 'active' && <button style={btnP} disabled={busy} onClick={() => {
            if (k.manager_drafts && !window.confirm(`${k.manager_drafts} manager review(s) are saved as drafts and not submitted. Locking closes reviews and strands them. Lock anyway?`)) return;
            setStatus('calibration');
          }}>Close reviews → calibration</button>}
          {c.status === 'calibration' && <><button style={btnS} disabled={busy} onClick={shareAll}>Share all finalized</button><button style={btnP} disabled={busy} onClick={() => setStatus('closed')}>Close cycle</button></>}
          {c.status !== 'draft' && c.status !== 'closed' && <button style={btnS} disabled={busy} onClick={openEnroll}>Manage enrollment</button>}
          {c.status === 'draft' && <button style={btnP} disabled={busy} onClick={openEnroll}>Enroll people</button>}
        </div>
      </header>

      {/* progress strip */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['Enrolled', k.enrolled], ['Self done', k.self_done, k.self_waived ? `+${k.self_waived} waived` : null], ['Mgr done', k.manager_done], ['Mgr drafts', k.manager_drafts],
          ['Calibrated', k.calibrated], ['Comp set', k.comp_set], ['Locked', k.locked], ['Shared', k.shared], ['PIP', k.pip]].map(([l, v, note]) => (
          <div key={l} style={tile}>
            <div style={{ fontSize: 20, fontWeight: 700, color: l === 'PIP' && v ? 'var(--state-error-fg)' : 'var(--text-1)' }}>{v}<span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>{l !== 'Enrolled' && l !== 'PIP' && l !== 'Mgr drafts' ? ` / ${k.enrolled}` : ''}</span></div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{l}</div>
            {note && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{note}</div>}
          </div>
        ))}
      </div>

      {enroll && <EnrollPanel enroll={enroll} setEnroll={setEnroll} busy={busy} doEnroll={doEnroll} />}

      <div className="ov-layout">
        <div style={{ minWidth: 0 }}>
          {/* controls */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <Seg value={groupBy} onChange={setGroupBy} options={[['manager', 'By manager'], ['department', 'By department']]} />
            <Seg value={filter} onChange={setFilter} options={FILTERS.map(f => [f[0], `${f[1]} ${rows.filter(f[2]).length}`])} />
          </div>
          {ov.can_comp && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 12, color: 'var(--text-2)' }}>
              <span>{sel.size ? `${sel.size} selected` : 'Select people to accept or lock in bulk'}</span>
              <button style={btnS} disabled={busy || !sel.size} onClick={acceptSelected}><Check size={12} /> Accept manager’s</button>
              <button style={btnP} disabled={busy || !selReady.length} onClick={() => lockSelected(selReady)}><Lock size={12} /> Lock in {selReady.length || ''}</button>
              <span style={{ flex: 1 }} />
              <button style={btnS} disabled={busy || !readyIds.length} onClick={() => lockSelected(readyIds)}><Lock size={12} /> Lock all ready ({readyIds.length})</button>
              {sel.size > 0 && <button style={{ ...btnS, border: 'none', background: 'none' }} onClick={() => setSel(new Set())}>Clear</button>}
            </div>
          )}

          {groups.length === 0 && <div style={{ ...cardBox, padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{rows.length ? 'No one matches this filter.' : 'No one enrolled yet.'}</div>}
          {groups.map(g => (
            <Group key={g.key} g={g} groupBy={groupBy} canComp={ov.can_comp} sel={sel} toggle={toggle} toggleMany={toggleMany}
              open={(rid) => router.push(`/appraisals/detail/?id=${rid}`)} />
          ))}
        </div>

        <aside className="ov-side">
          {ov.can_comp && ov.comp ? <BudgetPanel cycle={c} comp={ov.comp} session={session} onSaved={load} /> : (
            <div style={{ ...cardBox, padding: 14, fontSize: 12, color: 'var(--text-3)' }}>Compensation figures need salary access (comp allow-list).</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function groupRows(rows, groupBy) {
  const m = new Map();
  for (const a of rows) {
    const key = groupBy === 'manager' ? (a.manager_id || '_none') : (a.department || '_none');
    const label = groupBy === 'manager' ? (a.manager?.full_name || 'No manager') : (a.department || 'No department');
    if (!m.has(key)) m.set(key, { key, label, rows: [] });
    m.get(key).rows.push(a);
  }
  const out = [...m.values()].map(g => ({
    ...g,
    rows: g.rows.sort((x, y) => (x.employee?.full_name || '').localeCompare(y.employee?.full_name || '')),
    selfPending: g.rows.filter(a => !a.self_submitted_at && !a.self_review_waived_at).length,
    mgrPending: g.rows.filter(a => !a.manager_submitted_at).length,
  }));
  // Most to chase first.
  return out.sort((x, y) => (y.mgrPending + y.selfPending) - (x.mgrPending + x.selfPending) || x.label.localeCompare(y.label));
}

function Group({ g, groupBy, canComp, sel, toggle, toggleMany, open }) {
  const [collapsed, setCollapsed] = useState(false);
  const selectable = g.rows.filter(a => !a._own && !a.comp_locked_at).map(a => a.id);
  const allOn = selectable.length > 0 && selectable.every(x => sel.has(x));
  const n = g.rows.length;
  return (
    <div style={{ ...cardBox, marginBottom: 12 }}>
      <div style={{ ...cardHead, cursor: 'pointer' }} onClick={() => setCollapsed(v => !v)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canComp && <input type="checkbox" checked={allOn} disabled={!selectable.length} onClick={e => e.stopPropagation()} onChange={e => toggleMany(selectable, e.target.checked)} />}
          {collapsed ? '▸' : '▾'} {g.label}
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>· {n} {n === 1 ? 'person' : 'people'}</span>
        </span>
        <span style={{ display: 'flex', gap: 6, textTransform: 'none', letterSpacing: 0 }}>
          <Pill ok={!g.selfPending} text={g.selfPending ? `${g.selfPending} self pending` : 'self done'} />
          <Pill ok={!g.mgrPending} text={g.mgrPending ? `${g.mgrPending} ${groupBy === 'manager' ? 'reviews' : 'mgr reviews'} pending` : 'mgr done'} />
        </span>
      </div>
      {!collapsed && (
        <div style={{ overflowX: 'auto' }}>
          <table style={tbl}>
            <thead><tr>
              {canComp && <th style={{ ...th, width: 28 }}></th>}
              <th style={th}>Employee</th><th style={th}>Self</th><th style={th}>Manager</th><th style={th}>Final</th>
              {canComp && <><th style={thR}>Current CTC</th><th style={th}>Mgr recommends</th><th style={th}>Calibrated</th><th style={thR}>New CTC</th></>}
            </tr></thead>
            <tbody>
              {g.rows.map(a => <Row key={a.id} a={a} groupBy={groupBy} canComp={canComp} checked={sel.has(a.id)} toggle={toggle} open={open} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ a, groupBy, canComp, checked, toggle, open }) {
  const selfCell = a.self_submitted_at ? <Done r={a.self_overall_rating} />
    : a.self_review_waived_at ? <Muted t="waived" />
    : a.self_draft_saved_at ? <Warn t="draft" /> : <Warn t="pending" strong />;
  const mgrCell = a.manager_submitted_at ? <Done r={a.manager_overall_rating} />
    : a.manager_draft_saved_at ? <Warn t="draft" /> : <Warn t="pending" strong />;
  const rec = [a.manager_suggested_increment_pct != null ? `${a.manager_suggested_increment_pct}%` : null, a.manager_suggested_bonus ? `${fmtL(a.manager_suggested_bonus)} OTB` : null].filter(Boolean).join(' + ');
  const cal = [a.calibrated_increment_pct != null ? `${a.calibrated_increment_pct}%` : null, a.calibrated_bonus ? `${fmtL(a.calibrated_bonus)} OTB` : null].filter(Boolean).join(' + ');
  const sub = groupBy === 'manager' ? (a.department || a.employee?.job_title) : (a.manager?.full_name ? `→ ${a.manager.full_name}` : a.employee?.job_title);
  return (
    <tr className="ov-row" style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => open(a.id)}>
      {canComp && <td style={td} onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={checked} disabled={a._own || !!a.comp_locked_at} onChange={() => toggle(a.id)} />
      </td>}
      <td style={td}>
        <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{a.employee?.full_name}{a._own && <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}> · you</span>}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub || ''}{a.outcome === 'pip' ? ' · PIP' : ''}{a.status === 'shared' || a.status === 'acknowledged' ? ` · ${a.status}` : ''}</div>
      </td>
      <td style={td}>{selfCell}</td>
      <td style={td}>{mgrCell}</td>
      <td style={{ ...td, color: ratingColor(a.final_rating), fontWeight: 700 }}>{a.final_rating || '—'}</td>
      {canComp && <>
        <td style={{ ...tdR, fontVariantNumeric: 'tabular-nums' }}>{a.current_ctc != null ? fmtMoney(a.current_ctc) : <Muted t="no CTC" />}</td>
        <td style={{ ...td, fontSize: 12 }}>{rec || '—'}</td>
        <td style={{ ...td, fontSize: 12 }}>
          {cal || '—'}
          {a.comp_locked_at && <span title={`Locked ${fmtDate(a.comp_locked_at)}`} style={{ marginLeft: 5, color: 'var(--state-success-fg)' }}><Lock size={11} /></span>}
        </td>
        <td style={{ ...tdR, fontVariantNumeric: 'tabular-nums', color: a.new_ctc != null && a.new_ctc !== a.current_ctc ? 'var(--state-success-fg)' : 'var(--text-2)' }}>{a.new_ctc != null ? fmtMoney(a.new_ctc) : '—'}</td>
      </>}
    </tr>
  );
}

// Company-level figures for the cycle + the budget (spec §1).
function BudgetPanel({ cycle, comp, session, onSaved }) {
  const { showToast } = useToast();
  const [type, setType] = useState(cycle.budget_type || 'pct');
  const [value, setValue] = useState(cycle.budget_value ?? '');
  const [busy, setBusy] = useState(false);
  const b = comp.budget;
  const dirty = type !== (cycle.budget_type || 'pct') || String(value) !== String(cycle.budget_value ?? '');
  async function save() {
    setBusy(true);
    try { await podiumopsPost('setCycleBudget', { data: { cycle_id: cycle.id, budget_type: value === '' ? null : type, budget_value: value === '' ? null : Number(value) } }, session); showToast('Budget saved', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  const usedPct = b.amount ? Math.min(100, Math.max(0, (b.used / b.amount) * 100)) : 0;
  const over = b.remaining != null && b.remaining < 0;
  return (
    <>
      <div style={{ ...cardBox, padding: 14 }}>
        <div style={sideHead}>Budget</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
          <Seg value={type} onChange={setType} options={[['pct', '% of CTC'], ['amount', '₹ amount']]} />
          <input value={value} onChange={e => setValue(e.target.value)} type="number" min="0" step={type === 'pct' ? '0.5' : '100000'} placeholder={type === 'pct' ? 'e.g. 10' : 'e.g. 5000000'}
            style={{ ...miniInput, width: 0, flex: 1 }} />
          <button style={btnS} disabled={busy || !dirty} onClick={save}>Save</button>
        </div>
        {b.amount != null ? (
          <>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ width: `${usedPct}%`, height: '100%', background: over ? 'var(--state-error-fg)' : 'var(--podium-accent)' }} />
            </div>
            <Line l={`Budget${b.type === 'pct' ? ` (${b.value}% of ${fmtL(comp.ctc_before)})` : ''}`} v={fmtL(b.amount)} />
            <Line l="Used (increments + OTB)" v={fmtL(b.used)} />
            <Line l={over ? 'Over budget' : 'Remaining'} v={fmtL(Math.abs(b.remaining))} color={over ? 'var(--state-error-fg)' : 'var(--state-success-fg)'} bold />
          </>
        ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Set a budget to track spend against it.</div>}
      </div>

      <div style={{ ...cardBox, padding: 14 }}>
        <div style={sideHead}>Company · calibrated so far</div>
        <Line l="Annual CTC before" v={fmtL(comp.ctc_before)} />
        <Line l="Annual CTC after" v={fmtL(comp.ctc_after)} />
        <Line l="Increment cost (annual)" v={`+${fmtL(comp.increment_cost)}`} bold />
        <Line l="One-time bonuses" v={fmtL(comp.otb_total)} bold />
        <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
        <Line l={`Avg increment (${comp.increment_count} set)`} v={comp.avg_increment_pct != null ? `${comp.avg_increment_pct}%` : '—'} />
        <Line l="Weighted by CTC" v={comp.weighted_increment_pct != null ? `${comp.weighted_increment_pct}%` : '—'} />
        <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>If every manager recommendation were accepted</div>
        <Line l="Increment cost" v={`+${fmtL(comp.recommended.increment_cost)}`} />
        <Line l="One-time bonuses" v={fmtL(comp.recommended.otb_total)} />
        {comp.excludes_own && <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>Totals leave out your own appraisal.</p>}
        {comp.missing_ctc > 0 && <p style={{ fontSize: 11, color: 'var(--state-warning-fg)', marginTop: 8 }}>{comp.missing_ctc} enrolled {comp.missing_ctc === 1 ? 'person has' : 'people have'} no CTC on record — excluded from the CTC totals, and their increment can’t be locked in.</p>}
      </div>
    </>
  );
}

function EnrollPanel({ enroll, setEnroll, busy, doEnroll }) {
  return (
    <div style={{ ...cardBox, marginBottom: 16 }}>
      <div style={cardHead}><span>Enrollment — pick who to include</span><span><button style={btnS} onClick={() => setEnroll(null)}>Cancel</button> <button style={{ ...btnP, marginLeft: 6 }} disabled={busy} onClick={doEnroll}>Enroll selected</button></span></div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <table style={tbl}><thead><tr><th style={th}></th><th style={th}>Name</th><th style={th}>Joined</th><th style={th}>Eligibility</th><th style={th}>Period</th><th style={th}>Manager</th></tr></thead>
          <tbody>{enroll.map((r, i) => (
            <tr key={r.employee_id} style={{ borderTop: '1px solid var(--border)', opacity: r.already_enrolled ? 0.5 : 1 }}>
              <td style={td}><input type="checkbox" disabled={r.already_enrolled} checked={r.already_enrolled || r.pick} onChange={e => setEnroll(prev => prev.map((x, j) => j === i ? { ...x, pick: e.target.checked } : x))} /></td>
              <td style={td}>{r.full_name}</td>
              <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{r.date_joined ? fmtDate(r.date_joined) : '—'}</td>
              <td style={td}>{r.already_enrolled ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>enrolled</span> : <EligBadge r={r} />}</td>
              <td style={{ ...td, fontSize: 12 }}>{fmtMonths(r.review_period_months)}</td>
              <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{r.manager_name || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function EligBadge({ r }) {
  const map = { eligible: ['var(--state-success-fg)', 'eligible'], ineligible: ['var(--text-3)', 'not yet'], unknown: ['var(--state-warning-fg)', 'unknown'] };
  const [color, label] = map[r.eligibility] || ['var(--text-2)', r.eligibility];
  return <span style={{ fontSize: 11, color }}>{label}{r.flag ? ` · ${r.flag}` : ''}</span>;
}

function Seg({ value, onChange, options }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexWrap: 'wrap' }}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          style={{ background: value === v ? 'var(--surface-2)' : 'transparent', color: value === v ? 'var(--text-1)' : 'var(--text-3)', border: 'none', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontWeight: value === v ? 700 : 400 }}>{l}</button>
      ))}
    </div>
  );
}
function Pill({ ok, text }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: 'var(--surface-2)', color: ok ? 'var(--state-success-fg)' : 'var(--state-warning-fg)', border: '1px solid var(--border)' }}>{text}</span>;
}
function Done({ r }) { return <span style={{ color: ratingColor(r), fontWeight: 700 }}>✓ {r || ''}</span>; }
function Warn({ t, strong }) { return <span style={{ fontSize: 11, color: strong ? 'var(--state-error-fg)' : 'var(--state-warning-fg)', fontWeight: strong ? 700 : 400 }}>{t}</span>; }
function Muted({ t }) { return <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t}</span>; }
function Line({ l, v, color, bold }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0' }}><span style={{ color: 'var(--text-2)' }}>{l}</span><span style={{ color: color || 'var(--text-1)', fontWeight: bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{v}</span></div>;
}
// ₹ in lakh / crore for the summary panel.
function fmtL(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n), a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
  return `${s}${fmtMoney(a)}`;
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 10 };
const sub = { fontSize: 12, color: 'var(--text-3)', marginTop: 4 };
const back = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 12 };
const cardBox = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-2)' };
const sideHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-2)', marginBottom: 10 };
const tile = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 14px', textAlign: 'center', minWidth: 84 };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const thR = { ...th, textAlign: 'right' };
const td = { padding: '7px 10px', verticalAlign: 'middle' };
const tdR = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const miniInput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 12, outline: 'none' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnP = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnS = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
function badge(status) { const map = { draft: 'var(--text-3)', active: 'var(--state-success-fg)', calibration: 'var(--state-warning-fg)', closed: 'var(--text-3)' }; return { fontFamily: 'var(--font-mono)', fontSize: 10, color: map[status] || 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 7px', textTransform: 'uppercase' }; }
