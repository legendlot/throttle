'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useListNav, useToast } from '@throttle/ui';
import { Plus, Search } from 'lucide-react';
import { podiumopsGet } from '../../../../lib/podiumopsFetch.js';
import { FilterChip, GridHead, GridRow, gridTh, SoftPill, btnPrimary } from '../../../../components/ui.js';
import { ListBadge, ToneBadge } from '../../../../components/HiringBits.js';
import { OPENING_STATUSES, BUDGET_STATUSES, ACTIVE_APP_STATUSES, listOf, hiringError, formatBand } from '../../../../lib/hiring.js';

const TABS = [
  { id: 'live', label: 'Live' },          // draft + open + on_hold
  { id: 'open', label: 'Open' },
  { id: 'draft', label: 'Draft' },
  { id: 'on_hold', label: 'On Hold' },
  { id: 'filled', label: 'Filled' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];
const COLS = '2.2fr 1.1fr 1.3fr 110px 110px 1.2fr 90px 70px';

export default function OpeningsPage() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [tab, setTab] = useState('live');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/hiring/openings/detail/?id=${r.id}`);
  });

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = {};
    if (tab !== 'all' && tab !== 'live') params.status = tab;
    if (search) params.search = search;
    podiumopsGet('getOpenings', params, session)
      .then(d => {
        let list = listOf(d, 'openings');
        if (tab === 'live') list = list.filter(o => ['draft', 'open', 'on_hold'].includes(o.status));
        setRows(list);
      })
      .catch(e => { setRows([]); showToast(hiringError(e, 'Failed to load openings'), 'error'); })
      .finally(() => setLoading(false));
  }, [tab, search, session, showToast]);

  // createOpening = podium_hiring or a people manager. getMe.hiring.can_create (if the worker sends it)
  // is exact; otherwise fall back to hiring access — the worker refuses the rest.
  const h = brandUser?.hiring || {};
  const canCreate = h.can_create != null ? !!h.can_create
    : !!(brandUser?.permissions?.podium_hiring || h.access || brandUser?.permissions?.podium_hiring_access);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(t => <FilterChip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</FilterChip>)}
        <span style={{ flex: 1 }} />
        <label style={searchBox}>
          <Search size={14} strokeWidth={1.9} />
          <input data-search-primary value={search} onChange={e => setSearch(e.target.value)} placeholder="Search openings…" style={searchInput} />
        </label>
        {canCreate && <button onClick={() => router.push('/hiring/openings/new')} style={btnPrimary}><Plus size={14} strokeWidth={2.2} /> New opening</button>}
      </div>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>Opening</div>
            <div style={gridTh}>Department</div>
            <div style={gridTh}>Reporting manager</div>
            <div style={gridTh}>Status</div>
            <div style={gridTh}>JD</div>
            <div style={gridTh}>Band</div>
            <div style={gridTh}>Candidates</div>
            <div style={gridTh}>Seats</div>
          </GridHead>
          {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No openings</div>}
          {rows.map((o, i) => (
            <GridRow key={o.id} cols={COLS} onClick={() => router.push(`/hiring/openings/detail/?id=${o.id}`)} onMouseEnter={() => setFocusedIdx(i)} focused={focusedIdx === i}>
              <div style={cell}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{o.designation}</div>
                <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{o.opening_code}{o.job_role?.title ? ` · ${o.job_role.title}` : ''}</div>
              </div>
              <div style={cell}>{deptName(o) ? <SoftPill>{deptName(o)}</SoftPill> : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
              <div style={{ ...cell, fontSize: 12.5, color: 'var(--t3)' }}>{o.reporting_manager?.full_name || o.reporting_manager_name || '—'}</div>
              <div style={cell}><ListBadge list={OPENING_STATUSES} status={o.status} /></div>
              <div style={cell}>{o.has_jd ? <ToneBadge tone="ok" label="JD ✓" /> : <ToneBadge tone="warn" label="JD needed" />}</div>
              <div style={{ ...cell, fontSize: 12 }}>
                <ListBadge list={BUDGET_STATUSES} status={o.budget_status || 'none'} />
                {o.band && <div className="num" style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>{formatBand(o.band.band_min, o.band.band_max)}</div>}
                {!o.band && o.pending_band && <div className="num" style={{ fontSize: 11, color: 'var(--t4)', marginTop: 3 }}>{formatBand(o.pending_band.band_min, o.pending_band.band_max)} requested</div>}
              </div>
              <div className="num" style={{ ...cell, fontSize: 13 }}>
                {activeCount(o.application_counts)}<span style={{ color: 'var(--t4)', fontSize: 11 }}> / {totalCount(o.application_counts)}</span>
              </div>
              <div className="num" style={{ ...cell, fontSize: 13 }}>{o.headcount ?? 1}</div>
            </GridRow>
          ))}
        </div>
      )}
    </div>
  );
}

function deptName(o) { return o.department?.name || o.department_name || null; }
// application_counts = { <application status>: n } — "active / total".
function activeCount(c) { return Object.entries(c || {}).filter(([s]) => ACTIVE_APP_STATUSES.includes(s)).reduce((a, [, n]) => a + Number(n || 0), 0); }
function totalCount(c) { return Object.values(c || {}).reduce((a, n) => a + Number(n || 0), 0); }

const cell = { padding: '11px 16px', minWidth: 0 };
const searchBox = { display: 'flex', alignItems: 'center', gap: 8, width: 240, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--t4)' };
const searchInput = { flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5 };
