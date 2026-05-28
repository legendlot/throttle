'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@throttle/auth';
import { KpiCard, EmptyState, Spinner } from '@throttle/ui';
import { Search, PhoneIncoming, PhoneOutgoing, Phone, MoreHorizontal, ExternalLink, FilePlus2, CheckCheck, Filter } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import { CallStatusBadge } from '../../../components/CallStatusBadge.js';
import { getActiveDept } from '../../../components/DeptSwitcher.js';

const TABS = [
  { id: 'all',        label: 'All Calls' },
  { id: 'my',         label: 'My Calls' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'missed',     label: 'Missed' },
];

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

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function DirectionIcon({ direction }) {
  if (direction === 'incoming') return <PhoneIncoming size={13} style={{ color: '#16a34a' }} />;
  if (direction === 'outgoing') return <PhoneOutgoing size={13} style={{ color: '#4f46e5' }} />;
  return <Phone size={13} style={{ color: 'var(--t3)' }} />;
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
      const params = { tab: activeTab };
      if (direction) params.direction = direction;
      if (status)    params.status    = status;
      if (searchQ)   params.search    = searchQ;
      if (perms?.cs_ticket_admin) params.department = deptSlug || 'all';

      try {
        const d = await csopsGet('getCalls', params, session);
        if (alive) { setCalls(d?.calls || []); setError(null); }
      } catch (e) {
        if (alive) setError(e.message);
      } finally { if (alive) setLoading(false); }
    }
    go();
    const t = setInterval(go, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [session, activeTab, direction, status, searchQ, deptSlug, perms?.cs_ticket_admin]);

  function submitSearch(e) { e.preventDefault(); setParam('q', searchInput.trim()); }

  async function refresh() {
    const params = { tab: activeTab };
    if (direction) params.direction = direction;
    if (status)    params.status    = status;
    if (searchQ)   params.search    = searchQ;
    if (perms?.cs_ticket_admin) params.department = deptSlug || 'all';
    const d = await csopsGet('getCalls', params, session);
    setCalls(d?.calls || []);
    const k = await csopsGet('getCallsKpis', {}, session);
    setKpis(k);
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* KPI strip */}
      <section style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Calls today"      value={kpis?.total_today ?? '—'} />
        <KpiCard label="Answered today"   value={kpis?.answered_today ?? '—'} accent="green" />
        <KpiCard label="Missed today"     value={kpis?.missed_today ?? '—'} accent={kpis?.missed_today > 0 ? 'red' : null} />
        <KpiCard label="Answer rate"      value={kpis?.answer_rate_pct != null ? `${kpis.answer_rate_pct}%` : '—'} />
        <KpiCard label="Awaiting callback" value={kpis?.unanswered_awaiting_callback ?? '—'} accent={kpis?.unanswered_awaiting_callback > 0 ? 'red' : null} />
      </section>

      {/* Tabs */}
      <div style={{ display:'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--border-1)' }}>
        {TABS.map(t => {
          const isActive = activeTab === t.id;
          return (
            <button key={t.id} onClick={() => setParam('tab', t.id)} style={{
              background: 'none', border: 'none',
              padding: '8px 14px', cursor: 'pointer',
              color: isActive ? 'var(--yellow)' : 'var(--t2)',
              fontWeight: isActive ? 600 : 500,
              borderBottom: isActive ? '2px solid var(--yellow)' : '2px solid transparent',
              marginBottom: -1,
              fontSize: 13,
            }}>{t.label}</button>
          );
        })}
      </div>

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
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <Th>Time</Th><Th></Th><Th>Phone</Th><Th>Customer</Th><Th>Agent</Th><Th>Duration</Th><Th>Status</Th><Th>Ticket</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 40, textAlign: 'center' }}><Spinner /></td></tr>
            ) : calls.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: 'var(--t3)' }}>No calls match these filters.</td></tr>
            ) : calls.map(c => (
              <CallRow key={c.id} call={c} session={session} onAction={refresh} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CallRow({ call, session, onAction }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const ticketNo = call.ticket?.ticket_no;

  async function markCalled() {
    setMenuOpen(false);
    try { await csopsPost('markCalledBack', { call_id: call.id }, session); onAction(); }
    catch (e) { alert(e.message); }
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
    <tr style={{ borderTop: '1px solid var(--border-1)' }}>
      <Td>{fmtTime(call.started_at || call.created_at)}</Td>
      <Td><DirectionIcon direction={call.direction} /></Td>
      <Td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{call.customer_phone || '—'}</code></Td>
      <Td>{call.customer_name || (call.customer_phone ? `Caller ${maskPhone(call.customer_phone)}` : '—')}</Td>
      <Td>{call.agent_name || <span style={{ color: 'var(--t3)' }}>— unassigned —</span>}</Td>
      <Td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDuration(call.duration_seconds)}</Td>
      <Td><CallStatusBadge status={call.status} /></Td>
      <Td>
        {ticketNo ? (
          <Link href={`/queue/detail?ticket_no=${ticketNo}`} style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 12, textDecoration: 'none' }}>
            {ticketNo} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
          </Link>
        ) : (
          <span style={{ color: 'var(--t3)' }}>—</span>
        )}
      </Td>
      <Td style={{ position: 'relative' }}>
        <button onClick={() => setMenuOpen(o => !o)} style={btnIcon}>
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <div onMouseLeave={() => setMenuOpen(false)} style={{
            position: 'absolute', right: 8, top: '100%', zIndex: 50,
            background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 6,
            minWidth: 180, padding: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}>
            {!ticketNo && call.status === 'missed' && (
              <>
                <MenuItem icon={<FilePlus2 size={12} />} label="Create Ticket" onClick={convert} />
                {!call.called_back_at && <MenuItem icon={<CheckCheck size={12} />} label="Mark Called Back" onClick={markCalled} />}
              </>
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
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        padding:'4px 8px', background:'var(--surface-2)', border:'1px solid var(--border-1)',
        borderRadius: 5, fontSize: 12, color: 'var(--t1)',
      }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Th({ children }) { return <th style={{ textAlign:'left', padding:'8px 12px', fontSize:11, fontWeight:700, textTransform:'uppercase', color:'var(--t3)', letterSpacing:'0.05em' }}>{children}</th>; }
function Td({ children, ...rest }) { return <td {...rest} style={{ padding:'9px 12px', verticalAlign:'middle', ...rest.style }}>{children}</td>; }

const btnIcon = { padding:4, background:'transparent', border:'none', color:'var(--t3)', cursor:'pointer', display:'inline-flex', alignItems:'center' };
