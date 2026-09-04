'use client';
import { Fragment, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Target } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

const ORANGE = '#FF6B00';
function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN'); }
function curMonth() { return new Date().toISOString().slice(0, 7); }
function monthLabel(m) {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// Progress bar: views fill greens as it approaches/exceeds target; spend goes
// amber/red as it approaches/exceeds budget. Cosmetic only.
function Bar({ pct, kind }) {
  if (pct == null) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  const w = Math.min(100, Math.max(0, pct));
  let color = ORANGE;
  if (kind === 'spend') color = pct > 100 ? '#ff7070' : pct > 85 ? '#fbbf24' : '#4ade80';
  else color = pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : ORANGE;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
        <div style={{ width: `${w}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color, minWidth: 38, textAlign: 'right' }}>{pct}%</span>
    </div>
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

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Monthly Targets &amp; Budgets</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 4 }}>Set a views target and a budget for each month, then track actuals against them.</p>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {canManage && (
        <Panel title="Set / update a month">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Labeled label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} style={input} /></Labeled>
            <Labeled label="Target views"><input type="number" min="0" value={targetViews} onChange={e => setTargetViews(e.target.value)} placeholder="e.g. 5000000" style={input} /></Labeled>
            <Labeled label="Budget (₹)"><input type="number" min="0" value={budget} onChange={e => setBudget(e.target.value)} placeholder="e.g. 500000" style={input} /></Labeled>
            <Labeled label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} style={{ ...input, minWidth: 200 }} /></Labeled>
            <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Panel>
      )}

      <Panel title="Tracking">
        {rows == null ? <Spinner /> : rows.length === 0 ? (
          <EmptyState icon={Target} title="No targets yet" message={canManage ? 'Set one above to start tracking.' : 'No targets have been set.'} />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {['', 'Month', 'Target views', 'Actual views', 'Views %', 'Budget', 'Spent', 'Spend %', 'Note'].map((h, i) => (
                  <th key={h || 'exp'} style={{ ...thr, width: i === 0 ? 28 : undefined, textAlign: i === 0 || i === 1 || i === 8 ? 'left' : (i === 4 || i === 7 ? 'left' : 'right') }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {unalloc && unalloc.deals > 0 && (
                <Fragment key="unallocated">
                  <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                    <td style={{ ...tdl, width: 28 }}>
                      <button onClick={() => toggle('unallocated')} title="Show each unallocated spend"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 0 }}>
                        {open === 'unallocated' ? '▾' : '▸'}
                      </button>
                    </td>
                    <td style={{ ...tdl, fontWeight: 600 }}>
                      Unallocated
                      <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                        {unalloc.deals} deal{unalloc.deals === 1 ? '' : 's'} · not yet posted
                      </span>
                    </td>
                    <td style={tdr}>—</td>
                    <td style={tdr}>—</td>
                    <td style={tdl} />
                    <td style={tdr}>—</td>
                    <td style={{ ...tdr, fontWeight: 600 }}>{inr(unalloc.spend)}</td>
                    <td style={tdl} />
                    <td style={{ ...tdl, color: 'var(--text-3)', fontSize: 11 }}>Shipped, awaiting post</td>
                  </tr>
                  {open === 'unallocated' && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, background: 'var(--surface-2)' }}>
                        <MonthBreakdown month="unallocated" data={detail['unallocated']} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )}
              {rows.map(r => (
                <Fragment key={r.month}>
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...tdl, width: 28 }}>
                      <button onClick={() => toggle(r.month)} title="Show the individual spends and posts behind this month"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 0 }}>
                        {open === r.month ? '▾' : '▸'}
                      </button>
                    </td>
                    <td onClick={() => canManage && editRow(r)} style={{ ...tdl, fontWeight: 600, cursor: canManage ? 'pointer' : 'default', color: r.month === curMonth() ? ORANGE : 'var(--text-1)' }}>{monthLabel(r.month)}{r.month === curMonth() ? ' ·' : ''}</td>
                    <td style={tdr}>{num(r.target_views)}</td>
                    <td style={tdr}>{num(r.actual_views)}</td>
                    <td style={{ ...tdl, minWidth: 130 }}><Bar pct={r.views_pct} kind="views" /></td>
                    <td style={{ ...tdr, color: ORANGE }}>{inr(r.budget_amount)}</td>
                    <td style={tdr}>{inr(r.actual_spend)}</td>
                    <td style={{ ...tdl, minWidth: 130 }}><Bar pct={r.spend_pct} kind="spend" /></td>
                    <td style={tdl}>{r.note || '—'}</td>
                  </tr>
                  {open === r.month && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, background: 'var(--surface-2)' }}>
                        <MonthBreakdown month={r.month} data={detail[r.month]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {canManage && rows && rows.length > 0 && <p style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 8 }}>Tip: click a month name to edit it above, or the arrow to see what makes up the numbers.</p>}
      </Panel>
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
  const head = { ...cell, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, borderBottom: '1px solid var(--border)' };
  const who = (r) => (
    <>
      <span style={{ color: 'var(--text-1)' }}>{r.influencer_name || r.influencer_code || '—'}</span>
      {r.campaign_tag && <span style={{ marginLeft: 6, padding: '1px 5px', background: 'var(--surface-3)', borderRadius: 3, fontSize: 9 }}>{r.campaign_tag}</span>}
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
    <div style={{ padding: 14, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
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
        title={`Views — ${(t.views || 0).toLocaleString()} across ${t.view_lines || 0}`}
        empty="No posts with views this month." rows={data.views || []}
        cols={['Influencer', 'Posted', 'Views']}
        render={r => (
          <tr key={`v-${r.engagement_id}-${r.seq ?? 1}`}>
            <td style={cell}>{who(r)}{r.seq != null && r.seq > 1 ? <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>#{r.seq}</span> : null}{r.platform && <span style={{ marginLeft: 6, color: 'var(--text-3)', fontSize: 9 }}>{r.platform}</span>}</td>
            <td style={{ ...cell, textAlign: 'right' }}>{r.take_post_date || r.post_date || '—'}</td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--text-1)' }}>{Number(r.views).toLocaleString()}</td>
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

function Labeled({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>{label}</span>
      {children}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-2)' }}>{title}</div>
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const btnPrimary = { padding: '8px 18px', background: ORANGE, color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thr = { padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700, fontFamily: 'var(--font-mono)' };
const tdl = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-2)' };
const tdr = { padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 12.5 };
