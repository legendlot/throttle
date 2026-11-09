'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Percent, RefreshCw } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { istMonth } from '../../../lib/istDate.js';
import {
  commissionMonths, defaultCommissionMonth, monthLabel, reasonRequired, verifyProblem,
  canVerify, canReraise, canReopen, commissionTotals,
} from '../../../lib/commission.js';
import { DEAL_TYPE_LABELS } from '../../../lib/dealTypes.js';
import { FilterSelect, Banner, Modal } from '../../../components/ui/index.js';
import { CommissionBadge, Pill } from '../../../components/CommissionBadge.js';

// Monthly affiliate commission (Reann #3, S3). Ignition works out each affiliate deal's month from its
// code's sales (net of returns, ex-GST) × the deal's affiliate %; D2C checks it and verifies the final
// amount, which raises the Snorkel payment request (waiting for the creator's invoice). Every refusal
// is the worker's sentence, shown as it comes back.
const inr = n => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const istDay = d => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const istStamp = d => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function CommissionPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const canView = !!perms?.ignition_commission_verify || !!perms?.ignition_reports_view;
  const canVerifyPerm = !!perms?.ignition_commission_verify;
  const isAdmin = !!perms?.ignition_admin;

  const current = istMonth();
  const [month, setMonth] = useState(() => defaultCommissionMonth(istMonth()));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [verifying, setVerifying] = useState(null);   // the statement in the Verify modal
  const [busyId, setBusyId] = useState(null);
  const [bulk, setBulk] = useState(null);             // { month, running, done, total, failures: [{ id, label, message }] }
  const [rebuilding, setRebuilding] = useState(false);
  const seq = useRef(0);
  // The month on screen right now. Every async path checks it before it lands, so a reply (a load,
  // a bulk run's progress, a rebuild) started on another month never shows on this one.
  const monthRef = useRef(month);
  function pickMonth(m) { monthRef.current = m; setMonth(m); }

  // Only the latest call for the month on screen may land.
  function load(m = monthRef.current) {
    if (!session || !canView) { setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true);
    const fresh = () => n === seq.current && m === monthRef.current;
    ignitionopsGet('getCommissionStatements', { month: m }, session)
      .then(d => { if (fresh()) { setData(d); setError(null); } })
      .catch(e => { if (fresh()) { setData(null); setError(e.message); } })
      .finally(() => { if (fresh()) setLoading(false); });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(month), [session, month, canView]);
  useEffect(() => { setPicked(new Set()); setBulk(null); }, [month]);

  const rows = data?.statements || [];
  const selectable = rows.filter(s => canVerifyPerm && canVerify(s));
  const chosen = selectable.filter(s => picked.has(s.id));
  const totals = commissionTotals(rows);
  const lastComputed = rows.reduce((m, s) => (s.last_computed_at && (!m || s.last_computed_at > m) ? s.last_computed_at : m), null);
  const monthOpen = month >= (data?.current_month || current);
  const label = s => s.engagement_no || s.creator?.handle || 'deal';
  const shownBulk = bulk && bulk.month === month ? bulk : null;

  function toggle(id) {
    setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setPicked(chosen.length === selectable.length ? new Set() : new Set(selectable.map(s => s.id)));
  }

  // One call per row, in turn: each verify raises its own request, and one refusal must not stop the rest.
  // The run keeps going if the month is switched (the calls are already the user's decision), but its
  // progress and failures only ever show on the month it was started on.
  async function verifyAtEstimate() {
    const list = chosen;
    const m = monthRef.current;
    if (!list.length) return;
    const zero = list.filter(s => !(Number(s.estimate) > 0)).length;
    const pay = list.length - zero;
    const total = list.reduce((t, s) => t + Number(s.estimate || 0), 0);
    const parts = [];
    if (pay) parts.push(`${pay} raise${pay === 1 ? 's' : ''} a payment request in Snorkel, waiting for the creator's invoice`);
    if (zero) parts.push(`${zero} close${zero === 1 ? 's' : ''} at ₹0 with nothing to pay`);
    if (!window.confirm(`Verify ${list.length} deal${list.length === 1 ? '' : 's'} for ${monthLabel(m)} at Ignition's estimate (${inr(total)} in all)? ${parts.join('; ')}.`)) return;
    const failures = [];
    const progress = b => { if (monthRef.current === m) setBulk({ month: m, total: list.length, ...b }); };
    progress({ running: true, done: 0, failures });
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      try { await ignitionopsPost('verifyCommission', { statement_id: s.id, amount: Number(s.estimate), reason: null }, session); }
      catch (e) { failures.push({ id: s.id, label: label(s), message: e.message }); }
      progress({ running: true, done: i + 1, failures: [...failures] });
    }
    progress({ running: false, done: list.length, failures });
    const ok = list.length - failures.length;
    toast(`${monthLabel(m)}: ${failures.length ? `${ok} verified, ${failures.length} not${monthRef.current === m ? ' — see the list' : ''}` : `${ok} verified`}`, failures.length ? 'error' : 'success');
    if (monthRef.current === m) { setPicked(new Set()); load(m); }
  }

  async function rowAction(action, s) {
    if (action === 'reopenCommission'
      && !window.confirm(`Reopen ${label(s)} for ${monthLabel(s.month)}? The verified amount (${inr(s.verified_amount)}) is cleared and the month goes back to an estimate, to be verified again.`)) return;
    setBusyId(s.id);
    try {
      await ignitionopsPost(action, { statement_id: s.id }, session);
      toast(action === 'reopenCommission' ? 'Reopened — verify it again' : 'Raised again — waiting for the invoice', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusyId(null); load(); }   // load() drops itself if the month has changed since
  }

  async function rebuild() {
    const m = monthRef.current;   // the month on screen at the click
    setRebuilding(true);
    try {
      await ignitionopsPost('rebuildCommissionStatements', { month: m }, session);
      toast(`Estimates rebuilt for ${monthLabel(m)}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setRebuilding(false); load(); }
  }

  if (!canView) return <EmptyState icon={Percent} title="Access denied" message="Commission is for D2C and reports access." />;

  const head = [
    canVerifyPerm ? <input key="all" type="checkbox" aria-label="Select all" disabled={!selectable.length}
      checked={selectable.length > 0 && chosen.length === selectable.length} onChange={toggleAll} /> : null,
    'Deal', 'Creator', ['Orders', 'right'], ['Net sales (ex-GST)', 'right'], ['Rate', 'right'], ['Ignition estimate', 'right'],
    'State', ['Verified amount', 'right'], 'Reason', 'Verified by', 'Payment', '',
  ];

  return (
    <div style={{ maxWidth: 1240, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <header className="ig-up" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)' }}>ANALYZE · AFFILIATE COMMISSION</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Commission</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterSelect value={month} onChange={e => pickMonth(e.target.value)} aria-label="Month"
            options={commissionMonths(current).map(m => ({ value: m, label: m === current ? `${monthLabel(m)} (so far)` : monthLabel(m) }))} />
          {isAdmin && (
            <button type="button" onClick={rebuild} disabled={rebuilding} className="ig-ghost-btn" style={ghostBtn}>
              <RefreshCw size={14} strokeWidth={2} /> {rebuilding ? 'Rebuilding…' : 'Rebuild estimates'}
            </button>
          )}
        </div>
      </header>

      <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.5 }}>
        Each affiliate deal&apos;s month: its code&apos;s sales after returns, without GST or shipping, times the deal&apos;s affiliate %.
        Ignition&apos;s estimate updates every morning until the month is verified.
        {lastComputed && <> Estimates updated {istStamp(lastComputed)}.</>}
      </div>

      {monthOpen && (
        <Banner tone="info" lead={`${monthLabel(month)} is still running.`}>
          These are estimates so far — the month can be verified once it is over.
        </Banner>
      )}

      {canVerifyPerm && chosen.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
          <span style={{ color: 'var(--text-2)' }}>{chosen.length} selected</span>
          <button type="button" onClick={verifyAtEstimate} disabled={shownBulk?.running} className={shownBulk?.running ? undefined : 'ig-cta'} style={primaryBtn}>
            {shownBulk?.running ? `Verifying ${shownBulk.done}/${shownBulk.total}…` : 'Verify at estimate'}
          </button>
        </div>
      )}
      {shownBulk && !shownBulk.running && shownBulk.failures.length > 0 && (
        <Banner tone="error" lead={`${shownBulk.failures.length} not verified:`} action="Dismiss" onAction={() => setBulk(null)}>
          {shownBulk.failures.map(f => <div key={f.id}><strong>{f.label}</strong> — {f.message}</div>)}
        </Banner>
      )}

      {error && <Banner tone="error" lead="Could not load commission:" action="Retry" onAction={load}>{error}</Banner>}

      {loading && !data ? <Spinner /> : !error && rows.length === 0 ? (
        <div style={{ ...box, padding: '28px 20px', textAlign: 'center', color: 'var(--text-3)', fontSize: 14 }}>
          No affiliate sales {monthOpen ? 'this month yet' : `in ${monthLabel(month)}`}.
        </div>
      ) : rows.length > 0 && (
        // The table scrolls inside its own box below ~1150px, so the page itself never scrolls sideways.
        <div className="ig-up" style={{ ...box, overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
          <table style={{ width: '100%', minWidth: 1180, borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                {head.map((h, i) => {
                  const [l, align] = Array.isArray(h) ? h : [h, 'left'];
                  return <th key={i} style={{ ...th, textAlign: align }}>{l}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(s => {
                const busy = busyId === s.id;
                const diff = s.state === 'verified' && reasonRequired(s.verified_amount, s.estimate);
                return (
                  <tr key={s.id} className="ig-row" style={{ borderTop: '1px solid var(--border)' }}>
                    {canVerifyPerm && (
                      <td style={td}>
                        {canVerify(s) && <input type="checkbox" aria-label={`Select ${label(s)}`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}
                      </td>
                    )}
                    {!canVerifyPerm && <td style={{ ...td, padding: 0 }} />}
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <a href={`/engagements/detail/?id=${s.engagement_id}`}
                        onClick={ev => { ev.preventDefault(); router.push(`/engagements/detail/?id=${encodeURIComponent(s.engagement_id)}`); }}
                        style={{ color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                        {s.engagement_no || 'Open deal'}
                      </a>
                      {s.deal_type && <div style={{ fontSize: 12, color: 'var(--text-4)' }}>{DEAL_TYPE_LABELS[s.deal_type] || s.deal_type}</div>}
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{s.creator?.handle ? `@${s.creator.handle}` : (s.creator?.name || '—')}</div>
                      {s.creator?.handle && s.creator?.name && <div style={{ fontSize: 12, color: 'var(--text-4)' }}>{s.creator.name}</div>}
                    </td>
                    <td style={num}>{s.orders}</td>
                    <td style={num}>{inr(s.net_sales)}</td>
                    <td style={num}>{Number(s.rate)}%</td>
                    <td style={num}>{inr(s.estimate)}</td>
                    <td style={td}>{s.state === 'verified' ? <Pill label="Verified" tone="success" /> : <Pill label="Estimate" tone="neutral" />}</td>
                    <td style={{ ...num, fontWeight: 700, color: diff ? 'var(--state-warning-fg)' : 'var(--text-1)' }}>{s.state === 'verified' ? inr(s.verified_amount) : '—'}</td>
                    <td style={{ ...td, color: 'var(--text-2)', fontSize: 13, minWidth: 140, maxWidth: 240, overflowWrap: 'anywhere' }}>{s.difference_reason || '—'}</td>
                    <td style={{ ...td, fontSize: 13, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                      {s.state === 'verified' ? <>{s.verified_by_name || '—'}<div style={{ fontSize: 12, color: 'var(--text-4)' }}>{istDay(s.verified_at)}</div></> : '—'}
                    </td>
                    <td style={td}>
                      <CommissionBadge statement={s} />
                      {s.request?.snorkel_request_no && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)', marginTop: 2 }}>{s.request.snorkel_request_no}</div>}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {canVerifyPerm && s.state === 'estimated' && (
                          s.month_open
                            ? <span style={{ fontSize: 12, color: 'var(--text-4)', whiteSpace: 'normal', display: 'inline-block', maxWidth: 170, textAlign: 'right' }}>Can be verified once the month is over</span>
                            : <button type="button" disabled={busy} onClick={() => setVerifying(s)} className="ig-ghost-btn" style={miniBtn}>Verify</button>
                        )}
                        {canVerifyPerm && canReraise(s) && (
                          <button type="button" disabled={busy} onClick={() => rowAction('raiseCommissionPayment', s)} className="ig-ghost-btn" style={miniBtn}>Raise again</button>
                        )}
                        {isAdmin && canReopen(s) && (
                          <button type="button" disabled={busy} onClick={() => rowAction('reopenCommission', s)} className="ig-ghost-btn" style={miniBtn}>Reopen</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '1px solid var(--border-3)', fontWeight: 700 }}>
                <td style={td} />
                <td style={td} colSpan={2}>Total · {rows.length} deal{rows.length === 1 ? '' : 's'}</td>
                <td style={num}>{totals.orders}</td>
                <td style={num}>{inr(totals.net_sales)}</td>
                <td style={td} />
                <td style={num}>{inr(totals.estimate)}</td>
                <td style={td} />
                <td style={num}>{inr(totals.verified)}</td>
                <td style={td} colSpan={4} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {verifying && (
        <VerifyModal
          key={verifying.id}
          statement={verifying}
          session={session}
          onClose={() => setVerifying(null)}
          onDone={(msg) => { setVerifying(null); toast(msg, 'success'); load(); }}
        />
      )}
    </div>
  );
}

function VerifyModal({ statement: s, session, onClose, onDone }) {
  const [amount, setAmount] = useState(String(Number(s.estimate)));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needReason = reasonRequired(amount, s.estimate);
  const problem = verifyProblem(amount, s.estimate, reason);

  async function save() {
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      const r = await ignitionopsPost('verifyCommission', { statement_id: s.id, amount: Number(amount), reason: reason.trim() || null }, session);
      onDone(r?.request ? 'Verified — payment request raised, waiting for the invoice' : 'Verified — nothing to pay this month');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open title={`Verify ${s.engagement_no || 'commission'} · ${monthLabel(s.month)}`} onClose={onClose} onConfirm={save}
      confirmLabel="Verify" loading={busy} error={error} dismissOnBackdrop={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {s.creator?.handle ? `@${s.creator.handle}` : (s.creator?.name || '')} · {s.orders} order{s.orders === 1 ? '' : 's'} · net sales {inr(s.net_sales)} × {Number(s.rate)}% =
          {' '}<strong style={{ fontFamily: 'var(--font-mono)' }}>{inr(s.estimate)}</strong> (Ignition&apos;s estimate)
        </div>
        <div>
          <label style={lbl}>Verified amount (₹)</label>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={ev => { setAmount(ev.target.value); setError(''); }} style={ctl} autoFocus />
        </div>
        <div>
          <label style={lbl}>Reason for the difference{needReason ? ' *' : ' (only if the amount differs)'}</label>
          <textarea value={reason} onChange={ev => { setReason(ev.target.value); setError(''); }} rows={3} maxLength={1000} required={needReason}
            placeholder={needReason ? 'e.g. 2 orders returned after the estimate' : ''} style={{ ...ctl, resize: 'vertical' }} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
          Verifying raises the payment request in Snorkel; it waits for the creator&apos;s invoice. ₹0 closes the month with nothing to pay.
          Once verified, the amount is locked.
        </div>
      </div>
    </Modal>
  );
}

const box = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', minWidth: 0 };
const th = { padding: '12px 14px', fontSize: 12, color: 'var(--text-4)', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '10px 14px', verticalAlign: 'top' };
const num = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13, whiteSpace: 'nowrap' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 };
const ctl = { width: '100%', boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '9px 12px', fontFamily: 'var(--font-ui)', fontSize: 14 };
const miniBtn = { height: 30, padding: '0 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const ghostBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const primaryBtn = { height: 36, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
