'use client';
import { Fragment, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Target } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { istMonth, istToday } from '../../../lib/istDate.js';
import { Card, ProgressBar, viewsTone, spendTone } from '../../../components/ui/index.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN'); }
function curMonth() { return istMonth(); }
// Whole days from today (IST) to the end of the current month, today included.
function daysLeft() {
  const t = istToday();
  const [y, m, d] = t.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1;
}
function monthLabel(m) {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// Inline progress cell: "actual / target" + pct, over a 6px bar. pct null → no bar (no target set).
function Gauge({ actual, target, pct, tone, fmt, delay }) {
  if (pct == null) return <span style={{ color: 'var(--text-4)', fontSize: 12 }}>{actual != null ? fmt(actual) : '—'}</span>;
  const color = tone(pct);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <span>{fmt(actual)} <span style={{ color: 'var(--text-4)' }}>/ {fmt(target)}</span></span>
        <span style={{ color }}>{pct}%</span>
      </div>
      <ProgressBar pct={pct} color={color} height={6} delay={delay} />
    </div>
  );
}

// Ring gauge for the current month (120px, r=40, 10px stroke on a --border-2 track).
function Ring({ pct, color, label, value, sub, delay }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <Card style={{ display: 'flex', alignItems: 'center', gap: 18, animation: `igUp 500ms ${delay}ms both` }}>
      <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
        <svg width="120" height="120" viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border-2)" strokeWidth="10" />
          <circle cx="50" cy="50" r="40" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
            strokeDasharray="251" strokeDashoffset={251 - (251 * p) / 100}
            style={{ animation: `igDash 1.2s ${delay + 140}ms cubic-bezier(.22,1,.36,1) both` }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700 }}>{pct}%</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
        <div style={{ fontSize: 13, color: 'var(--text-4)' }}>{sub}</div>
      </div>
    </Card>
  );
}

export default function TargetsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.ignition_view;
  const canManage = !!perms?.ignition_manage;

  const [rows, setRows] = useState(null);
  // Reann #1 — spend on deals whose video has not posted, so it belongs to no month yet.
  const [unalloc, setUnalloc] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const { showToast: toast } = useToast();
  // Reann #8/#9 — the itemised rows behind a month. Fetched lazily on expand and cached, so
  // opening one month does not pull the whole year.
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});
  function toggle(month) {
    const next = open === month ? null : month;
    setOpen(next);
    if (next && detail[next] === undefined) {
      setDetail(d => ({ ...d, [next]: null }));   // null = loading
      ignitionopsGet('getMonthlyBreakdown', { month: next }, session)
        .then(r => setDetail(d => ({ ...d, [next]: r })))
        .catch(() => setDetail(d => ({ ...d, [next]: { error: true } })));
    }
  }

  const [month, setMonth] = useState(curMonth());
  const [targetViews, setTargetViews] = useState('');
  const [budget, setBudget] = useState('');
  const [note, setNote] = useState('');

  function load() {
    if (!session || !canView) return;
    ignitionopsGet('getMonthlyTargets', {}, session)
      .then(d => { setRows(d.months || []); setUnalloc(d.unallocated || null); setError(null); })
      .catch(e => setError(e.message));
  }
  useEffect(load, [session, canView]);

  function editRow(r) {
    setMonth(r.month);
    setTargetViews(r.target_views ?? '');
    setBudget(r.budget_amount ?? '');
    setNote(r.note || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save() {
    if (!/^\d{4}-\d{2}$/.test(month)) { toast('Pick a month', 'error'); return; }
    setSaving(true);
    try {
      await ignitionopsPost('upsertMonthlyTarget', {
        month, target_views: targetViews, budget_amount: budget, note,
      }, session);
      toast(`Saved target for ${monthLabel(month)}`, 'success');
      setTargetViews(''); setBudget(''); setNote('');
      load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  }

  if (!canView) return <EmptyState icon={Target} title="Access denied" message="You don't have the ignition_view permission." />;

  const cur = (rows || []).find(r => r.month === curMonth());
  const showViewsRing = cur && cur.views_pct != null;
  const showSpendRing = cur && cur.spend_pct != null;
  const showRings = showViewsRing || showSpendRing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ animation: 'igUp 500ms cubic-bezier(.22,1,.36,1) both' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>Analyze · Monthly</div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Targets &amp; budgets</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 4 }}>Set a views target and a budget for each month, then track actuals against them.</p>
      </div>

      {error && <div style={{ padding: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {(showRings || canManage) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 14 }}>
          {showViewsRing && (
            <Ring delay={60} pct={cur.views_pct} color={viewsTone(cur.views_pct)}
              label={`${monthLabel(cur.month).split(' ')[0]} · organic views`} value={num(cur.actual_views)}
              sub={`of ${num(cur.target_views)} · ${daysLeft()} days left`} />
          )}
          {showSpendRing && (
            <Ring delay={120} pct={cur.spend_pct} color={spendTone(cur.spend_pct)}
              label={`${monthLabel(cur.month).split(' ')[0]} · spend`} value={inr(cur.actual_spend)}
              sub={`of ${inr(cur.budget_amount)} budget`} />
          )}
          {canManage && (
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '18px 20px', animation: 'igUp 500ms 180ms both' }}>
              <div style={{ fontFamily: 'var(--font-cond)', fontSize: 15, fontWeight: 700 }}>Set / update a month</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8 }}>
                <Labeled label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} style={input} /></Labeled>
                <Labeled label="Target views"><input type="number" min="0" value={targetViews} onChange={e => setTargetViews(e.target.value)} placeholder="e.g. 5000000" style={input} /></Labeled>
                <Labeled label="Budget (₹)"><input type="number" min="0" value={budget} onChange={e => setBudget(e.target.value)} placeholder="e.g. 500000" style={input} /></Labeled>
                <Labeled label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} style={{ ...input, fontFamily: 'inherit' }} /></Labeled>
              </div>
              <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
            </Card>
          )}
        </div>
      )}

      <Card padding="0" style={{ overflowX: 'auto', animation: 'igUp 500ms 240ms both' }}>
        <div style={{ padding: '16px 20px', fontFamily: 'var(--font-cond)', fontSize: 15, fontWeight: 700 }}>Tracking</div>
        {rows == null ? <div style={{ padding: '0 20px 20px' }}><Spinner /></div> : rows.length === 0 ? (
          <div style={{ padding: '0 20px 20px' }}><EmptyState icon={Target} title="No targets yet" message={canManage ? 'Set one above to start tracking.' : 'No targets have been set.'} /></div>
        ) : (
          <table style={{ ...tableStyle, minWidth: 900 }}>
            <thead>
              <tr>
                {['', 'Month', 'Organic views vs target', 'Spend vs budget', 'Note'].map((h, i) => (
                  <th key={h || 'exp'} style={{ ...thr, width: i === 0 ? 28 : i === 1 ? 110 : undefined }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {unalloc && unalloc.deals > 0 && (
                <Fragment key="unallocated">
                  <tr className="ig-row" onClick={() => toggle('unallocated')} style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-sunk)', cursor: 'pointer' }}>
                    <td style={{ ...tdl, width: 28 }}><Chevron open={open === 'unallocated'} title="Show each unallocated spend" /></td>
                    <td style={{ ...tdl, fontWeight: 600, color: 'var(--text-1)' }}>Unallocated</td>
                    <td style={{ ...tdl, color: 'var(--text-4)', fontSize: 12 }}>
                      {unalloc.deals} deal{unalloc.deals === 1 ? '' : 's'} · not yet posted
                    </td>
                    <td style={{ ...tdl, fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{inr(unalloc.spend)}</td>
                    <td style={{ ...tdl, color: 'var(--text-4)', fontSize: 12 }}>Shipped, awaiting post</td>
                  </tr>
                  {open === 'unallocated' && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: 'var(--surface-sunk)' }}>
                        <MonthBreakdown month="unallocated" data={detail['unallocated']} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )}
              {rows.map((r, i) => (
                <Fragment key={r.month}>
                  <tr className="ig-row" style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...tdl, width: 28 }}><Chevron open={open === r.month} onClick={() => toggle(r.month)} title="Show the individual spends and posts behind this month" /></td>
                    <td onClick={() => canManage && editRow(r)} title={canManage ? 'Click to edit this month' : undefined} style={{ ...tdl, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, cursor: canManage ? 'pointer' : 'default', color: r.month === curMonth() ? 'var(--accent)' : 'var(--text-1)' }}>{monthLabel(r.month)}{r.month === curMonth() ? ' ·' : ''}</td>
                    <td style={{ ...tdl, minWidth: 240 }}>
                      <Gauge actual={r.actual_views} target={r.target_views} pct={r.views_pct} tone={viewsTone} fmt={num} delay={300 + i * 60} />
                      {Number(r.actual_paid_views) > 0 && <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>+ {num(r.actual_paid_views)} paid</div>}
                    </td>
                    <td style={{ ...tdl, minWidth: 240 }}><Gauge actual={r.actual_spend} target={r.budget_amount} pct={r.spend_pct} tone={spendTone} fmt={inr} delay={300 + i * 60} /></td>
                    <td style={{ ...tdl, color: 'var(--text-2)', fontSize: 13 }}>{r.note || '—'}</td>
                  </tr>
                  {open === r.month && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: 'var(--surface-sunk)' }}>
                        <MonthBreakdown month={r.month} data={detail[r.month]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {canManage && rows && rows.length > 0 && <p style={{ color: 'var(--text-4)', fontSize: 11, padding: '10px 20px 14px' }}>Tip: click a month name to edit it above, or the arrow to see what makes up the numbers.</p>}
      </Card>
    </div>
  );
}

// Reann #8 (spend + views drill-down) and #9 (conversions), the itemised rows behind one month.
function MonthBreakdown({ month, data }) {
  if (data === null || data === undefined) return <div style={{ padding: 14 }}><Spinner /></div>;
  if (data.error) return <div style={{ padding: 14, color: 'var(--state-error-fg)', fontSize: 12 }}>Could not load the breakdown for {month === 'unallocated' ? 'unallocated spend' : month}.</div>;

  const t = data.totals || {};
  const isUnalloc = month === 'unallocated';
  const cell = { padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' };
  const head = { ...cell, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, borderBottom: '1px solid var(--border)' };
  const who = (r) => (
    <>
      <span style={{ color: 'var(--text-1)' }}>{r.influencer_name || r.influencer_code || '—'}</span>
      {r.campaign_tag && <span style={{ marginLeft: 6, padding: '1px 5px', background: 'var(--border-2)', borderRadius: 3, fontSize: 9 }}>{r.campaign_tag}</span>}
    </>
  );

  const Section = ({ title, empty, rows, cols, render }) => (
    <div style={{ minWidth: 300, flex: 1 }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic', padding: '4px 8px' }}>{empty}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{cols.map((c, i) => <th key={c} style={{ ...head, textAlign: i === 0 ? 'left' : 'right' }}>{c}</th>)}</tr></thead>
          <tbody>{rows.map(render)}</tbody>
        </table>
      )}
    </div>
  );

  return (
    <div style={{ padding: '4px 20px 14px 64px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <Section
        title={`Spend — ₹${(t.spend || 0).toLocaleString()} across ${t.spend_lines || 0}`}
        empty={isUnalloc ? 'Nothing unallocated — every deal with spend has posted.' : 'No spend recorded this month.'} rows={data.spend || []}
        cols={['Influencer', 'Deal', 'Amount']}
        render={r => (
          <tr key={`s-${r.engagement_id}`}>
            <td style={cell}>{who(r)}</td>
            <td style={{ ...cell, textAlign: 'right' }}>
              <a href={`/engagements/detail?id=${r.engagement_id}`} style={{ color: 'var(--text-3)', textDecoration: 'none' }}>{r.engagement_no}</a>
            </td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--text-1)' }}>₹{Number(r.amount).toLocaleString()}</td>
          </tr>
        )}
      />
      {!isUnalloc && <Section
        title={`Organic views — ${(t.views || 0).toLocaleString()} across ${t.view_lines || 0}${t.paid_views ? ` (+ ${t.paid_views.toLocaleString()} paid, not counted)` : ''}`}
        empty="No posts with views this month." rows={data.views || []}
        cols={['Influencer', 'Posted', 'Organic views']}
        render={r => (
          <tr key={`v-${r.engagement_id}-${r.seq ?? 1}`}>
            <td style={cell}>{who(r)}{r.seq != null && r.seq > 1 ? <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>#{r.seq}</span> : null}{r.platform && <span style={{ marginLeft: 6, color: 'var(--text-3)', fontSize: 9 }}>{r.platform}</span>}</td>
            <td style={{ ...cell, textAlign: 'right' }}>{r.take_post_date || r.post_date || '—'}</td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--text-1)' }}>
              {Number(r.views).toLocaleString()}
              {Number(r.paid_views) > 0 && <span style={{ marginLeft: 6, color: 'var(--text-3)', fontSize: 9 }}>+{Number(r.paid_views).toLocaleString()} paid</span>}
            </td>
          </tr>
        )}
      />}
      {!isUnalloc && <Section
        title={`Conversions — ${t.orders || 0} orders · ₹${(t.order_value || 0).toLocaleString()}`}
        empty="No conversions recorded this month." rows={data.conversions || []}
        cols={['Influencer', 'Orders', 'Value']}
        render={r => (
          <tr key={`c-${r.engagement_id}`}>
            <td style={cell}>{who(r)}</td>
            <td style={{ ...cell, textAlign: 'right' }}>{Number(r.orders).toLocaleString()}</td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--text-1)' }}>₹{Number(r.order_value).toLocaleString()}</td>
          </tr>
        )}
      />}
    </div>
  );
}

function Chevron({ open, onClick, title }) {
  return (
    <button onClick={onClick} title={title} aria-expanded={open}
      style={{ background: 'transparent', border: 'none', color: 'var(--text-4)', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
        transition: 'transform 200ms', transform: open ? 'rotate(90deg)' : 'none' }}>›</button>
  );
}

function Labeled({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}>{label}</span>
      {children}
    </label>
  );
}

const input = { height: 38, padding: '0 10px', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 10, fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none', width: '100%', minWidth: 0 };
const btnPrimary = { alignSelf: 'flex-end', padding: '9px 18px', background: 'var(--accent)', color: '#0a0a0a', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const thr = { padding: '10px 20px', fontSize: 12, color: 'var(--text-4)', fontWeight: 600, textAlign: 'left' };
const tdl = { padding: '12px 20px', textAlign: 'left', color: 'var(--text-2)', verticalAlign: 'middle' };
