'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useListNav } from '@throttle/ui';
import { csopsGet } from '../../../lib/csopsFetch.js';
import { fetchIssueCatalog } from '../../../lib/issueCatalog.js';
import { DISPOSITION_VALUES, DISPOSITION_LABELS } from '../../../lib/dispositions.js';
import { DispositionBadge } from '../../../components/DispositionBadge.js';
import { TagChip } from '../../../components/TagPicker.js';
import { getActiveDept } from '../../../components/DeptSwitcher.js';
import { fmtIstDateTime } from '../../../lib/datetime.js';
import {
  KpiCard, Tabs, StagePill, Icon, btnPrimary, btnGhost, inputStyle, selectStyle, fmt,
} from '../../../components/kit/index.js';
import { dateStr } from '@throttle/domain';

const TABS = [
  { id: 'my',         label: 'My Queue' },
  { id: 'open',       label: 'All Open' },
  { id: 'awaiting',   label: 'Awaiting Evidence' },
  { id: 'logistics',  label: 'In Logistics' },
  { id: 'inspection', label: 'Inspection' },
  { id: 'resolution', label: 'Resolution' },
  { id: 'closure',    label: 'Closure Requests' },
  { id: 'closed',     label: 'Closed' },
];

const PLATFORMS = ['website', 'amazon', 'cred', 'blinkit', 'instamart', 'marketplace', 'offline', 'zepto', 'swiggy'];

const PAGE_SIZE = 50;

const TH = {
  textAlign: 'left', padding: '10px 14px', fontFamily: 'var(--f-display)', fontSize: 9.5,
  fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)',
};
const TD = { padding: 'var(--rowpad) 14px', verticalAlign: 'middle' };

function ageDays(createdAt) {
  if (!createdAt) return null;
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
}
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  return s.length < 4 ? s : s.slice(0, -3) + '***';
}

function AgeCell({ createdAt, dueAt, closedAt }) {
  if (!createdAt) return <span style={{ color: 'var(--t4)' }}>—</span>;
  if (closedAt) {
    const days = (new Date(closedAt) - new Date(createdAt)) / (1000 * 60 * 60 * 24);
    return <span className="num" style={{ color: 'var(--t3)', fontSize: 12 }}>{days.toFixed(0)}d</span>;
  }
  const d = ageDays(createdAt);
  const overdue = dueAt && Date.now() > new Date(dueAt).getTime();
  const color = overdue ? 'var(--bad-fg)' : d > 3 ? 'var(--warn-fg)' : 'var(--ok-fg)';
  const daysOver = overdue ? Math.floor((Date.now() - new Date(dueAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  return (
    <span>
      <span className="num" style={{ fontSize: 12, color, fontWeight: overdue ? 700 : 600 }}>{d.toFixed(0)}d</span>
      {daysOver > 0 && <span className="num" style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--bad-fg)' }}>{daysOver}d over</span>}
    </span>
  );
}

export default function QueuePage() {
  const { session, perms, brandUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const activeTab = searchParams.get('tab') || 'my';
  const dispositionFilter = searchParams.get('disposition') || '';
  const categoryFilter = searchParams.get('category') || '';
  const platformFilter = searchParams.get('platform') || '';
  const agentFilter = searchParams.get('agent') || '';
  const stageFilter = searchParams.get('stage') || '';
  const tagFilter = searchParams.get('tag') || '';
  const sortBy = searchParams.get('sort') || 'newest';
  const searchQ = searchParams.get('q') || '';

  const canFilterByAgent = !!(perms?.cs_ticket_admin || perms?.cs_ticket_reassign);

  const [deptSlug, setDeptSlug] = useState(() => getActiveDept(perms, brandUser?.cs_department_slug));
  useEffect(() => {
    function onChange() { setDeptSlug(getActiveDept(perms, brandUser?.cs_department_slug)); }
    window.addEventListener('pitstop:dept-changed', onChange);
    return () => window.removeEventListener('pitstop:dept-changed', onChange);
  }, [perms, brandUser?.cs_department_slug]);

  const [counts, setCounts] = useState({});
  const [kpis, setKpis] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState(searchQ);
  const [catalogCategories, setCatalogCategories] = useState([]);
  const [agents, setAgents] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [page, setPage] = useState(0);       // 0-based page index
  const [hasNext, setHasNext] = useState(false);

  // Reset to the first page whenever the tab / any filter / dept changes.
  useEffect(() => { setPage(0); }, [activeTab, dispositionFilter, categoryFilter, platformFilter, agentFilter, stageFilter, tagFilter, sortBy, searchQ, deptSlug]);

  const { focusedIdx, setFocusedIdx } = useListNav(
    tickets.length,
    (i) => { const t = tickets[i]; if (t) router.push(`/queue/detail/?ticket_no=${t.ticket_no}`); }
  );

  function setParam(key, value) {
    const params = new URLSearchParams(searchParams);
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
    router.push(`/queue?${params.toString()}`);
  }

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const fetchSummary = async () => {
      try {
        const countParams = {};
        if (agentFilter) countParams.agent = agentFilter;
        if (perms?.cs_ticket_admin) countParams.department = deptSlug || 'all';
        const [c, k] = await Promise.all([
          csopsGet('getQueueCounts', countParams, session),
          csopsGet('getKpis', {}, session),
        ]);
        if (alive) { setCounts(c || {}); setKpis(k); }
      } catch (e) { if (alive) setError(e.message); }
    };
    fetchSummary();
    const t = setInterval(fetchSummary, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [session, agentFilter, deptSlug, perms?.cs_ticket_admin]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    fetchIssueCatalog(session).then(cats => { if (alive) setCatalogCategories(cats); }).catch(() => {});
    csopsGet('getTags', {}, session).then(d => { if (alive) setAllTags(d?.tags || []); }).catch(() => {});
    return () => { alive = false; };
  }, [session]);

  useEffect(() => {
    if (!session || !canFilterByAgent) return;
    let alive = true;
    csopsGet('getDeptAgents', {}, session)
      .then(list => {
        if (!alive) return;
        setAgents((list || []).filter(a => a.has_cs_manage || a.has_cs_admin)
          .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')));
      }).catch(() => {});
    return () => { alive = false; };
  }, [session, canFilterByAgent]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    const params = { tab: activeTab, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (dispositionFilter) params.disposition = dispositionFilter;
    if (categoryFilter)    params.category    = categoryFilter;
    if (platformFilter)    params.platform    = platformFilter;
    if (agentFilter)       params.agent       = agentFilter;
    if (stageFilter)       params.stage       = stageFilter;
    if (tagFilter)         params.tag         = tagFilter;
    if (sortBy && sortBy !== 'newest') params.sort = sortBy;
    if (searchQ)           params.search      = searchQ;
    if (perms?.cs_ticket_admin) params.department = deptSlug || 'all';

    csopsGet('getTickets', params, session)
      .then(d => {
        if (!alive) return;
        const rows = d?.tickets || [];
        setTickets(rows);
        setHasNext(rows.length === PAGE_SIZE);   // a full page implies more may follow
        setError(null);
      })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, activeTab, dispositionFilter, categoryFilter, platformFilter, agentFilter, stageFilter, tagFilter, sortBy, searchQ, deptSlug, perms?.cs_ticket_admin, page]);

  function submitSearch(e) { e.preventDefault(); setParam('q', searchInput.trim()); }

  function exportCsv() {
    const rows = [
      ['ticket_no', 'customer', 'phone', 'product', 'model', 'disposition', 'stage', 'platform', 'agent', 'created_at', 'due_at', 'closed_at'],
      ...tickets.map(t => [
        t.ticket_no, t.customer_name || '', maskPhone(t.customer_phone), t.product || '', t.product_model || '',
        t.disposition || '', t.stage, t.platform || '', t.assigned_agent_name || '', t.created_at || '', t.due_at || '', t.closed_at || '',
      ]),
    ];
    const csv = rows.map(r => r.map(v => {
      const s = String(v == null ? '' : v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `pitstop-${activeTab}-${dateStr(new Date())}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  const kpiTiles = [
    { label: 'My open',     value: kpis?.my_open ?? '—',             tone: 'var(--accent)' },
    { label: 'Overdue',     value: kpis?.overdue ?? '—',             tone: 'var(--bad-fg)' },
    { label: 'Awaiting evidence', value: kpis?.awaiting_evidence_old ?? '—', tone: 'var(--warn-fg)' },
    { label: 'In logistics', value: counts?.logistics ?? '—',        tone: 'var(--info-fg)' },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        {kpiTiles.map((k, i) => <KpiCard key={i} {...k} sub="" size={26} />)}
      </div>

      {/* lifecycle tabs */}
      <Tabs tabs={TABS.map(t => ({ ...t, count: counts[t.id] }))} value={activeTab} onChange={(id) => setParam('tab', id)} />

      {/* filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={submitSearch} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 11px', flex: 1, minWidth: 200, maxWidth: 340 }}>
          <Icon name="search" size={14} style={{ color: 'var(--t4)' }} />
          <input data-search-primary value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Ticket #, customer, product…" style={{ flex: 1, background: 'transparent', border: 'none',
              outline: 'none', color: 'var(--t1)', fontFamily: 'var(--f-ui)', fontSize: 13 }} />
          {searchQ && <button type="button" onClick={() => { setSearchInput(''); setParam('q', ''); }}
            className="num" style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11 }}>clear</button>}
        </form>

        <select value={dispositionFilter} onChange={e => setParam('disposition', e.target.value)} style={selectStyle}>
          <option value="">Disposition</option>
          {DISPOSITION_VALUES.map(d => <option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>)}
        </select>

        <select value={categoryFilter} onChange={e => setParam('category', e.target.value)} style={selectStyle}>
          <option value="">All categories</option>
          {catalogCategories.map(c => <option key={c.category} value={c.category}>{c.category}</option>)}
        </select>

        <select value={platformFilter} onChange={e => setParam('platform', e.target.value)} style={selectStyle}>
          <option value="">Platform</option>
          {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        {allTags.length > 0 && (
          <select value={tagFilter} onChange={e => setParam('tag', e.target.value)} title="Filter by tag" style={selectStyle}>
            <option value="">All tags</option>
            {allTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}

          {/* Picking an agent while on My Queue used to AND `assigned_agent_id=eq.<me>` with
              `=eq.<them>` and return an always-empty list with no explanation; the worker now
              rejects that pair outright. `my` is the DEFAULT tab, so leaving it to the 400 would
              put an error banner on the landing view. Choosing an agent plainly means "show me
              their queue", so move off `my` to All Open instead of failing. */}
        {canFilterByAgent && (
          <select value={agentFilter}
            onChange={e => {
              const v = e.target.value;
              const params = new URLSearchParams(searchParams);
              if (v) params.set('agent', v); else params.delete('agent');
              if (v && activeTab === 'my') params.set('tab', 'open');
              router.push(`/queue?${params.toString()}`);
            }}
            title="Filter by the agent handling the ticket" style={selectStyle}>
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        )}

        <select value={sortBy} onChange={e => setParam('sort', e.target.value === 'newest' ? '' : e.target.value)} title="Sort tickets" style={selectStyle}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="due">Due date (soonest)</option>
          <option value="updated">Recently updated</option>
        </select>

        <span style={{ flex: 1 }} />
        <button onClick={exportCsv} style={btnGhost}><Icon name="ext" size={13} />Export CSV</button>
        <button onClick={() => router.push('/new')} style={btnPrimary}><Icon name="plus" size={14} />New ticket</button>
      </div>

      {error && (
        <div style={{ padding: 12, marginBottom: 12, background: 'var(--bad-bg)', color: 'var(--bad-fg)',
          border: '1px solid var(--bad-bd)', borderRadius: 'var(--radius-sm)', fontSize: 12.5 }}>{error}</div>
      )}

      {loading ? (
        <Spinner />
      ) : (tickets.length === 0 && page === 0) ? (
        <EmptyState icon={<Icon name="list" size={28} />} title="No tickets match" message="Adjust filters or open a new ticket." />
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th style={TH}>Ticket</th><th style={TH}>Customer</th><th style={TH}>Product</th>
              <th style={TH}>Disposition</th><th style={TH}>Stage</th><th style={TH}>Agent</th>
              <th style={{ ...TH }}>Age</th>
            </tr></thead>
            <tbody>
              {tickets.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 28, textAlign: 'center', color: 'var(--t4)' }}>No tickets on this page.</td></tr>
              )}
              {tickets.map((t, i) => (
                <tr key={t.id}
                  style={{ borderTop: '1px solid var(--border)', cursor: 'pointer',
                    background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                    boxShadow: focusedIdx === i ? 'inset 0 0 0 2px var(--accent-ring)' : 'none' }}
                  onMouseEnter={() => setFocusedIdx(i)}
                  onClick={() => router.push(`/queue/detail/?ticket_no=${t.ticket_no}`)}>
                  <td style={{ ...TD }}><span className="num" style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{t.ticket_no}</span></td>
                  <td style={TD}>
                    <div style={{ color: 'var(--t1)', fontWeight: 600 }}>{t.customer_name || '—'}</div>
                    <div className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{maskPhone(t.customer_phone)}</div>
                  </td>
                  <td style={{ ...TD, color: 'var(--t2)' }}>
                    {t.product || <span style={{ color: 'var(--t4)' }}>—</span>}
                    {t.product_model && <span style={{ color: 'var(--t4)' }}> · {t.product_model}</span>}
                    {t.product_color && <span style={{ color: 'var(--t4)' }}> · {t.product_color}</span>}
                    {(t.tags || []).length > 0 && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                        {t.tags.map(tag => <TagChip key={tag.id} tag={tag} small />)}
                      </div>
                    )}
                  </td>
                  <td style={TD}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <DispositionBadge disposition={t.disposition} compact />
                      {t.auto_created && <span className="num" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                        textTransform: 'uppercase', color: 'var(--t3)', background: 'var(--surface-3)',
                        border: '1px solid var(--border-2)', borderRadius: 4, padding: '1px 5px' }}>auto</span>}
                    </div>
                  </td>
                  <td style={TD}>
                    <StagePill stage={t.stage} />
                    {t.closure_requested_at && !t.closed_at && (
                      <div className="num" style={{ marginTop: 3, fontSize: 9.5, fontWeight: 700, color: 'var(--warn-fg)' }}>
                        closure req · {t.closure_requested_by_name || '—'}
                        {t.closure_request_reason ? ` · ${String(t.closure_request_reason).replace(/_/g, ' ')}` : ''}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, color: t.assigned_agent_name ? 'var(--t1)' : 'var(--t4)', fontWeight: 500 }}>{t.assigned_agent_name || 'Unassigned'}</td>
                  <td style={TD}><AgeCell createdAt={t.created_at} dueAt={t.due_at} closedAt={t.closed_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '9px 14px', background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--f-mono)',
            fontSize: 11, color: 'var(--t4)' }}>
            <span>
              {tickets.length > 0
                ? `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + tickets.length}`
                : '0 tickets'}
              {(page > 0 || hasNext) && <span style={{ color: 'var(--t4)' }}> · page {page + 1}</span>}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>↑↓ navigate · ↵ open · / search</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn(page === 0)}>‹ Prev</button>
                <button onClick={() => setPage(p => p + 1)} disabled={!hasNext} style={pageBtn(!hasNext)}>Next ›</button>
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function pageBtn(disabled) {
  return {
    padding: '4px 10px', borderRadius: 5,
    background: disabled ? 'transparent' : 'var(--surface-1)',
    border: '1px solid var(--border)',
    color: disabled ? 'var(--t4)' : 'var(--t1)',
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'var(--f-mono)', fontSize: 11,
    opacity: disabled ? 0.5 : 1,
  };
}
