'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useListNav } from '@throttle/ui';
import { Search, PhoneIncoming, PhoneOutgoing, Phone, MoreHorizontal, ExternalLink, FilePlus2, CheckCheck, Filter, CircleCheck, Undo2 } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import { CallStatusBadge } from '../../../components/CallStatusBadge.js';
import CallButton from '../../../components/CallButton.js';
import { getActiveDept } from '../../../components/DeptSwitcher.js';
import { KpiCard, Tabs, selectStyle } from '../../../components/kit/index.js';
import { TrendChart, hourFmt } from '../../../components/kit/Chart.js';
import { fmtIstShort } from '../../../lib/datetime.js';
import { dateStr } from '@throttle/domain';

const TABS = [
  { id: 'all',        label: 'All Calls' },
  { id: 'my',         label: 'My Calls' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'open',       label: 'Open' },        // call-linked tickets still open
  { id: 'closed',     label: 'Closed' },      // call-linked tickets resolved
  { id: 'missed',     label: 'Missed' },
  // Abandoned is NOT a flavour of missed and must not be folded into it: missed =
  // nobody picked up; abandoned = the caller reached us and hung up seconds in.
  // MyOperator logged every abandoned call as `answered`, which is why 44% of inbound
  // was invisible until 2026-08-20.
  { id: 'abandoned',  label: 'Abandoned' },
  { id: 'callback',   label: 'Needs callback' },
];

// What "Nothing needed" stamps. Matches what the team already picks on 427 of 428 of
// these, so the one-click path writes the same data a manual triage would.
const TRIVIAL_CATEGORY = 'General Queries';
const TRIVIAL_SUBCATEGORY = 'General queries';

const PAGE_SIZE = 50;

function maskPhone(p) {
  if (!p) return '—';
  const s = String(p);
  if (s.length < 4) return s;
  return s.slice(0, -3) + '***';
}

function fmtDuration(secs) {
  if (secs == null || secs <= 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Talk time is the honest number; leg time is what the line was open for and is what
// every historic metric was built on. Show talk, and reveal leg on hover rather than
// silently swapping one for the other.
function DurationCell({ call }) {
  const talk = call.talk_duration_seconds;
  const leg  = call.duration_seconds;
  if (talk == null) {
    return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDuration(leg)}</span>;
  }
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          title={`Talk ${fmtDuration(talk)} · line open ${fmtDuration(leg)}`}>
      {fmtDuration(talk)}
      {leg != null && leg !== talk && (
        <span style={{ color: 'var(--t4)', fontSize: 10.5 }}> /{fmtDuration(leg)}</span>
      )}
    </span>
  );
}

function fmtTime(iso) {
  return iso ? fmtIstShort(iso) : '—';
}

function DirectionIcon({ direction }) {
  if (direction === 'incoming') return <PhoneIncoming size={14} strokeWidth={1.75} style={{ color: 'var(--ok-fg)' }} />;
  if (direction === 'outgoing') return <PhoneOutgoing size={14} strokeWidth={1.75} style={{ color: 'var(--info-fg)' }} />;
  return <Phone size={14} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />;
}

export default function CallsPage() {
  const { session, perms, brandUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const activeTab = searchParams.get('tab') || 'all';
  const direction = searchParams.get('direction') || '';
  const status = searchParams.get('status') || '';
  const searchQ = searchParams.get('q') || '';

  const [deptSlug, setDeptSlug] = useState(() => getActiveDept(perms, brandUser?.cs_department_slug));
  useEffect(() => {
    function onChange() { setDeptSlug(getActiveDept(perms, brandUser?.cs_department_slug)); }
    window.addEventListener('pitstop:dept-changed', onChange);
    return () => window.removeEventListener('pitstop:dept-changed', onChange);
  }, [perms, brandUser?.cs_department_slug]);

  const [kpis, setKpis] = useState(null);
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState(searchQ);
  const [openCalldetailId, setOpenCalldetailId] = useState(null);
  const [page, setPage] = useState(0);      // 0-based page index
  const [hasNext, setHasNext] = useState(false);

  // Reset to the first page whenever the tab / filters / dept change.
  useEffect(() => { setPage(0); }, [activeTab, direction, status, searchQ, deptSlug]);

  // Hourly call-volume chart (a particular day, default today).
  const [chartDay, setChartDay] = useState(() => {
    // `ist` is already an IST wall-clock Date — read its LOCAL fields. `.toISOString()`
    // would shift it back off IST and default the chart to YESTERDAY before 05:30 IST.
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return dateStr(ist);
  });
  const [hourly, setHourly] = useState([]);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const params = { from: `${chartDay}T00:00:00`, to: `${chartDay}T23:59:59` };
    if (perms?.cs_ticket_admin && deptSlug) params.department = deptSlug;
    csopsGet('getCallReports', params, session)
      .then(d => { if (alive) setHourly(d?.hourly || []); })
      .catch(() => { if (alive) setHourly([]); });
    return () => { alive = false; };
  }, [session, chartDay, deptSlug, perms?.cs_ticket_admin]);

  // ↑/↓ navigates the visible row; Enter opens its ticket detail when linked,
  // else the call detail. Skipped while typing.
  const { focusedIdx, setFocusedIdx } = useListNav(
    calls.length,
    (i) => {
      const c = calls[i];
      if (!c) return;
      if (c.ticket?.ticket_no) router.push(`/queue/detail?ticket_no=${c.ticket.ticket_no}`);
      else router.push(`/calls/detail?id=${c.id}`);
    }
  );

  function setParam(key, value) {
    const params = new URLSearchParams(searchParams);
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
    router.push(`/calls?${params.toString()}`);
  }

  // KPIs (every 60s)
  useEffect(() => {
    if (!session) return;
    let alive = true;
    async function go() {
      try {
        const k = await csopsGet('getCallsKpis', {}, session);
        if (alive) setKpis(k);
      } catch (e) { /* ignore */ }
    }
    go();
    const t = setInterval(go, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [session]);

  // Calls list — also auto-refresh every 30s for live feel
  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    async function go() {
      const params = { tab: activeTab, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
      if (direction) params.direction = direction;
      if (status)    params.status    = status;
      if (searchQ)   params.search    = searchQ;
      if (perms?.cs_ticket_admin) params.department = deptSlug || 'all';

      try {
        const d = await csopsGet('getCalls', params, session);
        if (alive) {
          const rows = d?.calls || [];
          setCalls(rows);
          setHasNext(rows.length === PAGE_SIZE);   // a full page implies more may follow
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally { if (alive) setLoading(false); }
    }
    go();
    const t = setInterval(go, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [session, activeTab, direction, status, searchQ, deptSlug, perms?.cs_ticket_admin, page]);

  function submitSearch(e) { e.preventDefault(); setParam('q', searchInput.trim()); }

  async function refresh() {
    const params = { tab: activeTab, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (direction) params.direction = direction;
    if (status)    params.status    = status;
    if (searchQ)   params.search    = searchQ;
    if (perms?.cs_ticket_admin) params.department = deptSlug || 'all';
    const d = await csopsGet('getCalls', params, session);
    const rows = d?.calls || [];
    setCalls(rows);
    setHasNext(rows.length === PAGE_SIZE);
    const k = await csopsGet('getCallsKpis', {}, session);
    setKpis(k);
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* KPI strip */}
      <section style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        <KpiCard label="Calls today"       value={kpis?.total_today ?? '—'}    tone="var(--info-fg)" sub="all lanes" size={26} />
        <KpiCard label="Answered"          value={kpis?.answered_today ?? '—'} tone="var(--ok-fg)"   sub="someone spoke" size={26} />
        <KpiCard label="Missed"            value={kpis?.missed_today ?? '—'}   tone="var(--bad-fg)"  sub="nobody picked up" size={26} />
        <KpiCard label="Abandoned"         value={kpis?.abandoned_today ?? '—'} tone="var(--warn-fg)"
                 sub={kpis?.abandon_rate_pct != null ? `${kpis.abandon_rate_pct}% — hung up` : 'hung up first'} size={26} />
        <KpiCard label="Answer rate"       value={kpis?.answer_rate_pct != null ? `${kpis.answer_rate_pct}%` : '—'}
                 tone={(kpis?.answer_rate_pct != null && kpis.answer_rate_pct < 90) ? 'var(--warn-fg)' : 'var(--ok-fg)'}
                 sub="of calls that reached us" size={26} />
        <KpiCard label="Awaiting callback" value={kpis?.unanswered_awaiting_callback ?? '—'} tone="var(--warn-fg)" sub="tried, didn't reach us" size={26} />
      </section>

      {/* Hourly call-volume chart */}
      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 'var(--gap)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
          <span className="label" style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>Calls · hourly</span>
          <input type="date" value={chartDay} onChange={e => setChartDay(e.target.value)}
            style={{ ...selectStyle, padding: '5px 9px', fontFamily: 'var(--f-mono)', fontSize: 12 }} />
        </div>
        <div style={{ padding: '14px 10px 6px' }}>
          <TrendChart
            data={hourly}
            xKey="hour" xFmt={hourFmt} xLabel="Hour" height={220}
            series={[{ key: 'count', name: 'Calls', color: 'info', kind: 'area' }]}
          />
        </div>
      </section>

      {/* Tabs */}
      <Tabs tabs={TABS} value={activeTab} onChange={(id) => setParam('tab', id)} />

      {/* Filters row */}
      <div style={{ display:'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={submitSearch} style={{ display:'flex', alignItems:'center', gap: 6, background: 'var(--surface-2)', borderRadius: 6, padding: '4px 10px', border: '1px solid var(--border-1)' }}>
          <Search size={14} style={{ color: 'var(--t3)' }} />
          <input
            data-search-primary
            placeholder="Phone or customer…" value={searchInput} onChange={e => setSearchInput(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', color: 'var(--t1)', fontSize: 13, width: 220 }}
          />
        </form>
        <FilterSelect label="Direction" value={direction} onChange={v => setParam('direction', v)} options={[['','All'],['incoming','In'],['outgoing','Out']]} />
        <FilterSelect label="Status"    value={status}    onChange={v => setParam('status', v)}    options={[['','All'],['answered','Answered'],['missed','Missed'],['abandoned','Abandoned']]} />
      </div>

      {/* Errors */}
      {error && <div style={{ padding: 10, background: 'rgba(239,68,68,0.1)', color: '#dc2626', borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{error}</div>}

      {/* Table */}
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              <Th>Time</Th><Th></Th><Th>Phone</Th><Th>Customer</Th><Th>Agent</Th><Th>Talk</Th><Th>Status</Th><Th>Ticket</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 40, textAlign: 'center' }}><Spinner /></td></tr>
            ) : calls.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: 'var(--t3)' }}>No calls match these filters.</td></tr>
            ) : calls.map((c, i) => (
              <CallRow key={c.id} call={c} session={session} onAction={refresh}
                focused={focusedIdx === i}
                onMouseEnter={() => setFocusedIdx(i)} />
            ))}
          </tbody>
        </table>
        {!loading && (calls.length > 0 || page > 0) && (
          <div style={{
            padding: '8px 14px',
            background: 'var(--surface-2)',
            borderTop: '1px solid var(--border-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--t3)',
          }}>
            <span>
              {calls.length > 0
                ? `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + calls.length}`
                : '0 calls'}
              {(page > 0 || hasNext) && <span style={{ color: 'var(--t4)' }}> · page {page + 1}</span>}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--t4)' }}>
                <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open · <Kbd>/</Kbd> search
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn(page === 0)}>‹ Prev</button>
                <button onClick={() => setPage(p => p + 1)} disabled={!hasNext} style={pageBtn(!hasNext)}>Next ›</button>
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }) {
  return (
    <kbd style={{
      display: 'inline-block', padding: '0 5px', margin: '0 2px',
      background: 'var(--surface-1, var(--surface))', border: '1px solid var(--border-1, var(--border))',
      borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10,
      color: 'var(--t2)', minWidth: 14, textAlign: 'center', lineHeight: '14px',
    }}>{children}</kbd>
  );
}

function CallRow({ call, session, onAction, focused, onMouseEnter }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);   // drives the inline Undo affordance
  const router = useRouter();
  const ticketNo = call.ticket?.ticket_no;

  async function markCalled() {
    setMenuOpen(false);
    try { await csopsPost('markCalledBack', { call_id: call.id }, session); onAction(); }
    catch (e) { alert(e.message); }
  }

  // The inverse of markCalled(). Both the abandoned and missed tabs exclude
  // `called_back_at`-stamped rows, so a mis-click drops the call out of the worklist
  // the agent is working - this is the only way back without going via All Calls.
  async function undoCalled() {
    setMenuOpen(false);
    try { await csopsPost('undoCalledBack', { call_id: call.id }, session); onAction(); }
    catch (e) { alert(e.message); }
  }

  // One-click close for a call that needed nothing.
  //
  // No new endpoint: updateTicket already fast-closes on disposition 'query'
  // (stage -> closed, closed_reason 'resolved'), and it gates on cs_ticket_manage,
  // which every cs_agent holds. ⚠️ Do NOT switch this to closeTicket — that takes the
  // mid-flight path and demands cs_ticket_admin, locking ordinary agents out.
  //
  // This is the actual fix for the ~26h median it took to clear these: the cost was
  // never ticket creation, it was that closing one meant opening a triage form.
  async function nothingNeeded() {
    setMenuOpen(false);
    setBusy(true);
    try {
      await csopsPost('updateTicket', {
        ticket_id: call.ticket_id,
        patch: {
          disposition: 'query',
          issue_category: TRIVIAL_CATEGORY,
          issue_subcategory: TRIVIAL_SUBCATEGORY,
        },
      }, session);
      setClosed(true);
      onAction();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  // Undo is a genuine round-trip: re-triaging to 'pending' on a closed ticket clears
  // closed_at/closed_reason and returns it to intake — its exact prior state.
  async function undoClose() {
    setBusy(true);
    try {
      await csopsPost('updateTicket', {
        ticket_id: call.ticket_id,
        patch: { disposition: 'pending' },
      }, session);
      setClosed(false);
      onAction();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  function convert() {
    setMenuOpen(false);
    // Navigate to /new prefilled with call context
    const qs = new URLSearchParams({
      from_call: call.id,
      phone: call.customer_phone || '',
      name: call.customer_name || '',
    }).toString();
    router.push(`/new?${qs}`);
  }

  return (
    <tr onMouseEnter={onMouseEnter} style={{
      borderTop: '1px solid var(--border-1)',
      background: focused ? 'var(--surface-2)' : 'transparent',
      boxShadow: focused ? 'inset 0 0 0 2px var(--accent)' : 'none',
    }}>
      <Td>{fmtTime(call.started_at || call.created_at)}</Td>
      <Td><DirectionIcon direction={call.direction} /></Td>
      <Td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{call.customer_phone || '—'}</code></Td>
      <Td>{call.customer_name || (call.customer_phone ? `Caller ${maskPhone(call.customer_phone)}` : '—')}</Td>
      <Td>{call.agent_name || <span style={{ color: 'var(--t3)' }}>— unassigned —</span>}</Td>
      <Td><DurationCell call={call} /></Td>
      <Td><CallStatusBadge status={call.status} /></Td>
      <Td>
        {ticketNo ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Link href={`/queue/detail?ticket_no=${ticketNo}`} style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 12, textDecoration: 'none' }}>
              {ticketNo} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
            </Link>
            {closed && (
              <button onClick={undoClose} disabled={busy} title="Reopen this ticket"
                style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'1px 6px',
                         background:'var(--surface-2)', border:'1px solid var(--border-1)',
                         borderRadius:4, color:'var(--t2)', fontSize:10.5, cursor:'pointer' }}>
                <Undo2 size={10} /> Undo
              </button>
            )}
          </span>
        ) : (
          <span style={{ color: 'var(--t3)' }}>—</span>
        )}
      </Td>
      <Td style={{ position: 'relative', whiteSpace: 'nowrap' }}>
        <CallButton phone={call.customer_phone} ticketId={call.ticket_id} size="sm" label="Call" onPlaced={onAction} />
        <button onClick={() => setMenuOpen(o => !o)} style={{ ...btnIcon, marginLeft: 4 }}>
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <div onMouseLeave={() => setMenuOpen(false)} style={{
            position: 'absolute', right: 8, top: '100%', zIndex: 50,
            background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 6,
            minWidth: 180, padding: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}>
            {!ticketNo && (call.status === 'missed' || call.status === 'abandoned') && (
              <>
                <MenuItem icon={<FilePlus2 size={12} />} label="Create Ticket" onClick={convert} />
                {!call.called_back_at && <MenuItem icon={<CheckCheck size={12} />} label="Mark Called Back" onClick={markCalled} />}
              </>
            )}
            {ticketNo && call.needs_callback && !call.called_back_at && (
              <MenuItem icon={<CheckCheck size={12} />} label="Mark Called Back" onClick={markCalled} />
            )}
            {/* ⚠️ Only reachable from All Calls (and any tab not keyed on called_back_at):
                the abandoned, missed and callback tabs all exclude stamped rows, so a
                mis-clicked row leaves the worklist immediately. All Calls is the way back. */}
            {call.called_back_at && (
              <MenuItem icon={<Undo2 size={12} />} label="Undo called back" onClick={undoCalled} />
            )}
            {ticketNo && call.ticket_id && !closed && (
              <MenuItem icon={<CircleCheck size={12} />} label="Nothing needed — close" onClick={nothingNeeded} />
            )}
            {ticketNo && <MenuItem icon={<ExternalLink size={12} />} label="Open Ticket" onClick={() => router.push(`/queue/detail?ticket_no=${ticketNo}`)} />}
            {!ticketNo && call.status !== 'missed' && (
              <MenuItem icon={<FilePlus2 size={12} />} label="Create Ticket" onClick={convert} />
            )}
            <MenuItem icon={<ExternalLink size={12} />} label="Open Call Detail" onClick={() => router.push(`/calls/detail?id=${call.id}`)} />
          </div>
        )}
      </Td>
    </tr>
  );
}

function MenuItem({ icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      display:'flex', alignItems:'center', gap: 8, width: '100%',
      padding: '7px 10px', background: 'transparent', border: 'none',
      cursor: 'pointer', color: 'var(--t1)', fontSize: 12, textAlign: 'left',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2)'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      {icon}{label}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label style={{ display:'inline-flex', alignItems:'center', gap: 6, fontSize: 12, color: 'var(--t3)' }}>
      <Filter size={12} />
      {label}:
      <select value={value} onChange={e => onChange(e.target.value)} style={{ ...selectStyle, padding: '6px 9px', fontSize: 12.5 }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Th({ children }) { return <th style={{ textAlign:'left', padding:'10px 12px', fontFamily:'var(--f-display)', fontSize:9.5, fontWeight:700, textTransform:'uppercase', color:'var(--t3)', letterSpacing:'0.1em' }}>{children}</th>; }
function Td({ children, ...rest }) { return <td {...rest} style={{ padding:'9px 12px', verticalAlign:'middle', ...rest.style }}>{children}</td>; }

const btnIcon = { padding:4, background:'transparent', border:'none', color:'var(--t3)', cursor:'pointer', display:'inline-flex', alignItems:'center' };

function pageBtn(disabled) {
  return {
    padding: '4px 10px', borderRadius: 5,
    background: disabled ? 'transparent' : 'var(--surface-1)',
    border: '1px solid var(--border-1)',
    color: disabled ? 'var(--t4)' : 'var(--t1)',
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'var(--font-mono)', fontSize: 11,
    opacity: disabled ? 0.5 : 1,
  };
}
