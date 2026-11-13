'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useListNav, Combobox } from '@throttle/ui';
import { Search, Briefcase, UploadCloud } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { Avatar, FilterChip, GridHead, GridRow, gridTh, btnGhost } from '../../../components/ui.js';
import { ListBadge } from '../../../components/HiringBits.js';
import { LoadError } from '../../../components/LoadError.js';
import { APP_STATUSES, listOf, hiringError } from '../../../lib/hiring.js';

const TABS = [
  { id: '', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'screening', label: 'Screening' },
  { id: 'interviewing', label: 'Interviewing' },
  { id: 'on_hold', label: 'On Hold' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
];
const COLS = '2fr 1.6fr 1.5fr 1.6fr 120px';

export default function CandidatesPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [openings, setOpenings] = useState([]);
  const [query, setQuery] = useState('');        // `search`, debounced — what the server is asked for
  const [result, setResult] = useState(null);    // { key, rows } — tagged with what was asked
  const [rowsErr, setRowsErr] = useState(null);  // { key, msg }
  const [openingsErr, setOpeningsErr] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const reqSeq = useRef(0);

  // One request per pause in typing (250 ms), not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Results are shown only while they answer what is asked now (no other query's rows paint or take an
  // Enter under this one), and only the LATEST request may store.
  const keyNow = `${query}|${status}|${openingId}`;
  const rowsNow = result?.key === keyNow ? result.rows : null;
  const errNow = rowsErr?.key === keyNow ? rowsErr.msg : null;
  const rows = rowsNow || [];
  // Typed text not yet asked (the 250 ms debounce): the rows on screen answer the previous text — keep them
  // visible but inert (no click, no Enter-to-open) until the matching results arrive.
  const pending = search !== query;
  const openable = pending ? [] : rows;
  const { focusedIdx, setFocusedIdx } = useListNav(openable.length, (i) => {
    const r = openable[i]; if (r) router.push(`/hiring/detail/?id=${r.id}`);
  });

  // A failed read is an error with a Retry — never "No candidates" or an empty openings picker.
  const loadOpenings = useCallback(() => {
    if (!session) return;
    setOpeningsErr(null);
    podiumopsGet('getOpenings', {}, session).then(d => setOpenings(listOf(d, 'openings'))).catch(setOpeningsErr);
  }, [session]);
  useEffect(() => { loadOpenings(); }, [loadOpenings]);

  useEffect(() => {
    const mine = ++reqSeq.current;
    if (!session) return;
    const key = `${query}|${status}|${openingId}`;
    setRowsErr(null);
    podiumopsGet('getCandidates', { search: query, status, opening_id: openingId }, session)
      .then(d => { if (mine === reqSeq.current) setResult({ key, rows: listOf(d, 'candidates') }); })
      .catch(e => { if (mine === reqSeq.current) setRowsErr({ key, msg: hiringError(e, 'Failed to load candidates') }); });
  }, [session, query, status, openingId, retryKey]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(t => <FilterChip key={t.id || 'all'} active={status === t.id} onClick={() => setStatus(t.id)}>{t.label}</FilterChip>)}
        <div style={{ width: 220, marginLeft: 4 }}>
          <Combobox value={openingId} onChange={v => setOpeningId(v)} inputStyle={{ fontFamily: 'var(--font-ui)', fontSize: 13, padding: '6px 10px' }}
            placeholder="All openings" options={openings.map(o => ({ value: o.id, label: o.designation, hint: o.opening_code }))} />
        </div>
        {openingsErr && <LoadError compact message="Openings didn't load." onRetry={loadOpenings} />}
        <span style={{ flex: 1 }} />
        <label style={searchBox}>
          <Search size={14} strokeWidth={1.9} />
          <input data-search-primary value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, email, phone…" style={searchInput} />
        </label>
        <button onClick={() => router.push('/hiring/openings')} style={btnGhost}><Briefcase size={13} /> Openings</button>
        <button onClick={() => router.push('/hiring/import')} style={btnGhost}><UploadCloud size={13} /> Import CVs</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 10 }}>Candidates are added from an opening (the JD comes first).</div>

      {errNow && rowsNow && <LoadError compact message="Couldn't refresh candidates — showing the last list loaded." onRetry={() => setRetryKey(k => k + 1)} style={{ marginBottom: 10 }} />}
      {errNow && !rowsNow ? <LoadError message={errNow} onRetry={() => setRetryKey(k => k + 1)} /> : !rowsNow ? <Spinner /> : (
        <div aria-busy={pending} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden', ...(pending ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>Candidate</div>
            <div style={gridTh}>Contact</div>
            <div style={gridTh}>Now</div>
            <div style={gridTh}>Latest opening</div>
            <div style={gridTh}>Status</div>
          </GridHead>
          {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No candidates</div>}
          {rows.map((c, i) => {
            const la = c.latest_application || {};
            return (
              <GridRow key={c.id} cols={COLS} onClick={() => !pending && router.push(`/hiring/detail/?id=${c.id}`)} onMouseEnter={() => setFocusedIdx(i)} focused={focusedIdx === i}>
                <div style={{ ...cell, display: 'flex', alignItems: 'center', gap: 11 }}>
                  <Avatar name={c.full_name} tintKey={c.id} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{c.full_name}</div>
                    <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{c.candidate_code}</div>
                  </div>
                </div>
                <div style={{ ...cell, fontSize: 12, color: 'var(--t3)' }}>
                  <div style={ellipsis}>{c.email || '—'}</div>
                  <div className="num">{c.phone || ''}</div>
                </div>
                <div style={{ ...cell, fontSize: 12, color: 'var(--t3)' }}>
                  <div style={ellipsis}>{c.current_title || '—'}</div>
                  <div>{c.location || ''}</div>
                </div>
                <div style={{ ...cell, fontSize: 12.5, color: 'var(--t2)' }}>
                  <div style={ellipsis}>{la.designation || c.latest_designation || '—'}</div>
                  <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{la.opening_code || c.latest_opening_code || ''}</div>
                </div>
                <div style={cell}>{(la.status || c.latest_status) ? <ListBadge list={APP_STATUSES} status={la.status || c.latest_status} /> : '—'}</div>
              </GridRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

const cell = { padding: '11px 16px', minWidth: 0 };
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const searchBox = { display: 'flex', alignItems: 'center', gap: 8, width: 240, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--t4)' };
const searchInput = { flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5 };
