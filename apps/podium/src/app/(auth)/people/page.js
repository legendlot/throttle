'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useListNav, Combobox } from '@throttle/ui';
import { UserPlus, RefreshCw, Search } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import StatusBadge from '../../../components/StatusBadge.js';
import DirectorySyncModal from '../../../components/DirectorySyncModal.js';
import { Avatar, FilterChip, GridHead, GridRow, gridTh, SoftPill, btnPrimary, btnGhost } from '../../../components/ui.js';

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'on_leave', label: 'On Leave' },
  { id: 'notice', label: 'Notice' },
  { id: 'exited', label: 'Exited' },
  { id: 'all', label: 'All' },
];
const COLS = '2.2fr 1.6fr 1.2fr 1.3fr 120px';

export default function PeoplePage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [all, setAll] = useState([]);
  const [depts, setDepts] = useState([]);
  const [dept, setDept] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/people/detail/?id=${r.id}`);
  });

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getDepartments', {}, session).then(d => setDepts(d.departments || [])).catch(() => {});
    podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session).then(e => setAll(e.employees || [])).catch(() => {});
  }, [session, reloadKey]);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { status: tab, limit: 1000 };
    if (search) params.search = search;
    if (dept) params.department_id = dept;
    podiumopsGet('getEmployees', params, session)
      .then(r => setRows(r.employees || []))
      .finally(() => setLoading(false));
  }, [tab, search, dept, session, reloadKey]);

  const c = (s) => all.filter(e => e.status === s).length;
  const newCount = all.filter(e => withinDays(e.date_joined, 30)).length;

  return (
    <div>
      {syncOpen && (
        <DirectorySyncModal session={session} onClose={() => setSyncOpen(false)} onDone={() => setReloadKey(k => k + 1)} />
      )}

      {/* Summary strip */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 11, padding: '14px 20px', marginBottom: 18, flexWrap: 'wrap', gap: '12px 0' }}>
        <Stat value={c('active')} label="Headcount" color="var(--yellow)" first />
        <Stat value={depts.length} label="Departments" />
        <Stat value={c('on_leave')} label="On Leave" color="var(--warn-fg)" />
        <Stat value={c('notice')} label="Notice" color="var(--bad-fg)" />
        <Stat value={newCount} label="New · 30d" color="var(--green-bright)" last />
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 240, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--t4)' }}>
          <Search size={14} strokeWidth={1.9} />
          <input data-search-primary value={search} onChange={e => setSearch(e.target.value)} placeholder="Search directory…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5 }} />
        </label>
      </div>

      {/* Filters + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(t => <FilterChip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</FilterChip>)}
        <div style={{ width: 180, marginLeft: 4 }}>
          <Combobox value={dept} onChange={v => setDept(v)} inputStyle={{ fontFamily: 'var(--font-ui)', fontSize: 13, padding: '6px 10px' }}
            placeholder="All departments" options={depts.map(d => ({ value: d.id, label: d.name }))} />
        </div>
        <span style={{ flex: 1 }} />
        {perms?.podium_hr && (
          <>
            <button onClick={() => setSyncOpen(true)} style={btnGhost}><RefreshCw size={13} strokeWidth={2.1} /> Sync from Google</button>
            <button onClick={() => router.push('/people/new')} style={btnPrimary}><UserPlus size={14} strokeWidth={2.2} /> New Person</button>
          </>
        )}
      </div>

      {/* Avatar table */}
      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>Person</div>
            <div style={gridTh}>Title</div>
            <div style={gridTh}>Department</div>
            <div style={gridTh}>Manager</div>
            <div style={gridTh}>Status</div>
          </GridHead>
          {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No results</div>}
          {rows.map((r, i) => (
            <GridRow key={r.id} cols={COLS} onClick={() => router.push(`/people/detail/?id=${r.id}`)} onMouseEnter={() => setFocusedIdx(i)} focused={focusedIdx === i}>
              <div style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 11 }}>
                <Avatar name={r.full_name} photoUrl={r.photo_url} tintKey={r.id} size={34} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{r.full_name}{r.preferred_name && <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 6 }}>({r.preferred_name})</span>}</div>
                  <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{r.employee_code}</div>
                </div>
              </div>
              <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t2)' }}>{r.job_title || '—'}</div>
              <div style={{ padding: '11px 16px' }}>{r.department?.name ? <SoftPill>{r.department.name}</SoftPill> : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
              <div style={{ padding: '11px 16px', fontSize: 12.5, color: 'var(--t3)' }}>
                {r.manager?.full_name || '—'}
                {r.secondary_manager?.full_name && <div style={{ fontSize: 11, color: 'var(--t4)' }}>⋯ {r.secondary_manager.full_name} <span style={{ fontStyle: 'italic' }}>(dotted)</span></div>}
              </div>
              <div style={{ padding: '11px 16px' }}><StatusBadge status={r.status} /></div>
            </GridRow>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, color = 'var(--t1)', first, last }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: first ? '0 22px 0 0' : last ? '0 0 0 22px' : '0 22px', borderRight: last ? 'none' : '1px solid var(--divider)' }}>
      <span className="num" style={{ fontSize: 20, fontWeight: 600, color }}>{value}</span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{label}</span>
    </div>
  );
}
function withinDays(d, n) {
  if (!d) return false;
  const dt = new Date(d); if (isNaN(dt)) return false;
  const days = Math.round((Date.now() - dt.getTime()) / 86400000);
  return days >= 0 && days <= n;
}
