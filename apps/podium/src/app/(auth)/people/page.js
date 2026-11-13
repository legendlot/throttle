'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Skeleton, useListNav, Combobox } from '@throttle/ui';
import { UserPlus, RefreshCw, Search, KeyRound } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { levelLabel, teamOptions } from '../../../lib/format.js';
import StatusBadge from '../../../components/StatusBadge.js';
import DirectorySyncModal from '../../../components/DirectorySyncModal.js';
import { OverrideAccountModal } from '../../../components/WorkAccountBits.js';
import { LoadError } from '../../../components/LoadError.js';
import { directoryRows, filterOnServer, DIRECTORY_ALL_LIMIT } from '../../../lib/directory.mjs';
import { Avatar, FilterChip, GridHead, GridRow, gridTh, SoftPill, btnPrimary, btnGhost } from '../../../components/ui.js';

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'on_leave', label: 'On Leave' },
  { id: 'notice', label: 'On notice' },   // worker: ?status=notice = people with an open exit
  { id: 'exited', label: 'Exited' },
  { id: 'all', label: 'All' },
];
const COLS = '2.2fr 1.6fr 1.2fr 1.3fr 120px';

export default function PeoplePage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');        // `search`, debounced — what the server is asked for
  const [all, setAll] = useState(null);          // getEmployees status=all — counts + the unsearched list
  const [allErr, setAllErr] = useState(null);
  const [depts, setDepts] = useState(null);
  const [deptsErr, setDeptsErr] = useState(null);
  const [found, setFound] = useState(null);      // { key, rows } — server search results, tagged with what was asked
  const [foundErr, setFoundErr] = useState(null); // { key, err }
  const [dept, setDept] = useState('');
  const [syncOpen, setSyncOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [searchKey, setSearchKey] = useState(0);
  const searchSeq = useRef(0);

  const loadDepts = useCallback(() => {
    if (!session) return;
    setDeptsErr(null);
    podiumopsGet('getDepartments', {}, session).then(d => setDepts(d.departments || [])).catch(setDeptsErr);
  }, [session]);
  const loadAll = useCallback(() => {
    if (!session) return;
    setAllErr(null);
    podiumopsGet('getEmployees', { status: 'all', limit: DIRECTORY_ALL_LIMIT }, session).then(e => setAll(e.employees || [])).catch(setAllErr);
  }, [session]);
  useEffect(() => { loadDepts(); loadAll(); }, [loadDepts, loadAll, reloadKey]);

  // One request per pause in typing (250 ms), not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Text search stays on the server (it matches more fields than the list shows), and so do the tab and
  // department filters if the full list may be cut off (filterOnServer). Results are stored with the
  // query/tab/department they answer and shown only while that is still what is asked — so another query's
  // rows never paint (or take an Enter) under this one; and only the LATEST request may store.
  const q = query.trim();
  const server = filterOnServer({ query: q, all });
  const searchKeyNow = `${q}|${tab}|${dept}`;
  useEffect(() => {
    const mine = ++searchSeq.current;
    if (!session || !server) return;
    const key = `${q}|${tab}|${dept}`;
    setFoundErr(null);
    const params = { status: tab, limit: 1000 };
    if (q) params.search = q;
    if (dept) params.department_id = dept;
    podiumopsGet('getEmployees', params, session)
      .then(r => { if (mine === searchSeq.current) setFound({ key, rows: r.employees || [] }); })
      .catch(err => { if (mine === searchSeq.current) setFoundErr({ key, err }); });
  }, [q, server, tab, dept, session, reloadKey, searchKey]);

  // No search text → the tab and department filters run over the full list already loaded (the same
  // rows a filtered call returns — lib/directory.mjs says why), so switching tabs costs no request.
  const local = useMemo(() => (all ? directoryRows(all, { tab, dept }) : null), [all, tab, dept]);
  const foundNow = found?.key === searchKeyNow ? found.rows : null;
  const foundErrNow = foundErr?.key === searchKeyNow ? foundErr.err : null;
  const rows = (server ? foundNow : local) || [];
  // The table gives way to an error only when it has nothing to show. A failed BACKGROUND reload (after a
  // Google sync) keeps the list it holds, with a small note.
  const listErr = server ? (foundNow ? null : foundErrNow) : (all ? null : allErr);
  const staleNote = server ? !!(foundNow && foundErrNow) : !!(all && allErr);
  const listLoading = server ? !foundNow && !foundErrNow : all === null && !allErr;
  const retryList = server ? () => setSearchKey(k => k + 1) : loadAll;
  // Typed text not yet asked (the 250 ms debounce): the rows on screen answer the previous text — keep them
  // visible but inert (no click, no Enter-to-open) until the matching results arrive.
  const pending = search.trim() !== q;
  const openable = pending ? [] : rows;

  const { focusedIdx, setFocusedIdx } = useListNav(openable.length, (i) => {
    const r = openable[i]; if (r) router.push(`/people/detail/?id=${r.id}`);
  });

  const everyone = all || [];
  const c = (s) => everyone.filter(e => e.status === s).length;
  const newCount = everyone.filter(e => withinDays(e.date_joined, 30)).length;
  const stat = (v) => (all ? v : <Skeleton width={22} height={18} style={{ display: 'inline-block' }} />);

  return (
    <div>
      {syncOpen && (
        <DirectorySyncModal session={session} onClose={() => setSyncOpen(false)} onDone={() => setReloadKey(k => k + 1)} />
      )}
      {overrideOpen && <OverrideAccountModal session={session} onClose={() => setOverrideOpen(false)} />}

      {/* Summary strip */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 11, padding: '14px 20px', marginBottom: 18, flexWrap: 'wrap', gap: '12px 0' }}>
        {allErr && !all ? <LoadError compact message="Couldn't load the directory counts." onRetry={loadAll} style={{ paddingRight: 22 }} /> : <>
          <Stat value={stat(c('active'))} label="Headcount" color="var(--yellow)" first />
          {deptsErr && !depts ? <span style={{ padding: '0 22px', borderRight: '1px solid var(--divider)' }}><LoadError compact message="Departments didn't load." onRetry={loadDepts} /></span>
            : <Stat value={depts ? depts.length : <Skeleton width={22} height={18} style={{ display: 'inline-block' }} />} label="Departments" />}
          <Stat value={stat(c('on_leave'))} label="On Leave" color="var(--warn-fg)" />
          {/* X1: on notice = an open exit (status stays active), so it is a flag, not a status count. */}
          <Stat value={stat(everyone.filter(e => e.on_notice).length)} label="On notice" color="var(--bad-fg)" />
          <Stat value={stat(newCount)} label="New · 30d" color="var(--green-bright)" last />
        </>}
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
            placeholder="All departments" options={teamOptions(depts || [])} />
        </div>
        <span style={{ flex: 1 }} />
        {/* J1: display flag only (podium.google_admin_access) — the worker re-checks every call. */}
        {perms?.podium_google_admin && (
          <button onClick={() => setOverrideOpen(true)} style={btnGhost}><KeyRound size={13} strokeWidth={2.1} /> Create account without hiring</button>
        )}
        {perms?.podium_hr && (
          <>
            <button onClick={() => setSyncOpen(true)} style={btnGhost}><RefreshCw size={13} strokeWidth={2.1} /> Sync from Google</button>
            <button onClick={() => router.push('/people/new')} style={btnPrimary}><UserPlus size={14} strokeWidth={2.2} /> New Person</button>
          </>
        )}
      </div>

      {staleNote && <LoadError compact message="Couldn't refresh the directory — showing the last list loaded." onRetry={retryList} style={{ marginBottom: 10 }} />}
      {/* Avatar table */}
      {listLoading ? <Spinner /> : listErr ? <LoadError message={q ? "Search didn't load." : "Couldn't load the directory."} onRetry={retryList} /> : (
        <div aria-busy={pending} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden', ...(pending ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>Person</div>
            <div style={gridTh}>Title</div>
            <div style={gridTh}>Department</div>
            <div style={gridTh}>Manager</div>
            <div style={gridTh}>Status</div>
          </GridHead>
          {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No results</div>}
          {rows.map((r, i) => (
            <GridRow key={r.id} cols={COLS} onClick={() => !pending && router.push(`/people/detail/?id=${r.id}`)} onMouseEnter={() => setFocusedIdx(i)} focused={focusedIdx === i}>
              <div style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 11 }}>
                <Avatar name={r.full_name} photoUrl={r.photo_url} tintKey={r.id} size={34} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{r.full_name}{r.preferred_name && <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 6 }}>({r.preferred_name})</span>}</div>
                  <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{r.employee_code}</div>
                </div>
              </div>
              <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t2)' }}>
                {r.job_title || '—'}
                {r.level?.code && <div style={{ fontSize: 11, color: 'var(--t4)' }}>{levelLabel(r.level)}</div>}
              </div>
              <div style={{ padding: '11px 16px' }}>{r.department?.name ? <SoftPill>{r.department.name}</SoftPill> : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
              <div style={{ padding: '11px 16px', fontSize: 12.5, color: 'var(--t3)' }}>
                {r.manager?.full_name || (r.manager_to_be_hired ? <span style={{ fontStyle: 'italic' }}>To be hired</span> : '—')}
                {r.secondary_manager?.full_name && <div style={{ fontSize: 11, color: 'var(--t4)' }}>⋯ {r.secondary_manager.full_name} <span style={{ fontStyle: 'italic' }}>(dotted)</span></div>}
              </div>
              <div style={{ padding: '11px 16px' }}><StatusBadge status={r.status} onNotice={r.on_notice} /></div>
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
