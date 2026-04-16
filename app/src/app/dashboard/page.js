'use client';
import { useEffect, useState, useCallback } from 'react';
import Layout from '@/components/Layout';
import TaskDrillModal from '@/components/TaskDrillModal';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { DELIVERABLE_TYPES } from '@/lib/taskConfig';

// ── Deliverable column config ────────────────────────────────────────────────

const DEL_COLS = [
  { key: 'graphic',       label: 'Graphic' },
  { key: 'video',         label: 'Video' },
  { key: 'photo',         label: 'Photo' },
  { key: '3d_render',     label: '3D / Render' },
  { key: 'copy',          label: 'Copy' },
  { key: 'deck',          label: 'Deck' },
  { key: 'social_post',   label: 'Social Post' },
  { key: 'ad_creative',   label: 'Ad Creative' },
  { key: 'listing_image', label: 'Listing Image' },
  { key: 'other',         label: 'Other' },
];

// ── StatCard ─────────────────────────────────────────────────────────────────

const CARD_ACCENTS = {
  cyan:   '#22d3ee',
  red:    'var(--red)',
  amber:  'var(--amber)',
  green:  'var(--green)',
  orange: 'var(--amber)',
};

function StatCard({ label, value, bucket, color, onClick }) {
  const accent = CARD_ACCENTS[color] || CARD_ACCENTS.green;
  return (
    <div
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--b1)',
        borderRadius: 6,
        borderLeft: `3px solid ${accent}`,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 80,
        ...(bucket ? { cursor: 'pointer' } : {}),
      }}
      onClick={bucket ? onClick : undefined}
    >
      <div style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 24, color: 'var(--text)' }}>{value}</div>
      <div style={{ fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ── SprintSelector ───────────────────────────────────────────────────────────

function SprintSelector({ sprints, value, onChange }) {
  return (
    <select
      value={value || ''}
      onChange={e => {
        const sprint = sprints.find(s => s.id === e.target.value);
        if (sprint) onChange(sprint);
      }}
      style={{
        background: 'var(--s2)',
        border: '1px solid var(--b2)',
        borderRadius: 6,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--t2)',
        padding: '6px 12px',
        outline: 'none',
      }}
    >
      {sprints.map(s => (
        <option key={s.id} value={s.id}>
          {s.name} {s.status === 'active' ? '● Active' : ''}
        </option>
      ))}
    </select>
  );
}

// ── DateRangePicker ──────────────────────────────────────────────────────────

function DateRangePicker({ start, end, onChange }) {
  const [localStart, setLocalStart] = useState(start);
  const [localEnd, setLocalEnd] = useState(end);
  const [error, setError] = useState('');

  useEffect(() => {
    setLocalStart(start);
    setLocalEnd(end);
    setError('');
  }, [start, end]);

  function handleApply() {
    if (localStart > localEnd) {
      setError('Start date must be before end date.');
      return;
    }
    setError('');
    onChange({ start: localStart, end: localEnd });
  }

  const dateInputStyle = {
    background: 'var(--s2)',
    border: '1px solid var(--b2)',
    borderRadius: 6,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--t2)',
    padding: '6px 8px',
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="date"
        value={localStart}
        onChange={e => setLocalStart(e.target.value)}
        style={dateInputStyle}
      />
      <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>to</span>
      <input
        type="date"
        value={localEnd}
        onChange={e => setLocalEnd(e.target.value)}
        style={dateInputStyle}
      />
      <button
        onClick={handleApply}
        style={{
          background: 'transparent',
          color: 'var(--t2)',
          border: '1px solid var(--b2)',
          borderRadius: 6,
          fontFamily: 'var(--mono)',
          fontSize: 11,
          padding: '6px 12px',
          cursor: 'pointer',
        }}
      >
        Apply
      </button>
      {error && <span style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>{error}</span>}
    </div>
  );
}

// ── ViewToggle ───────────────────────────────────────────────────────────────

function ViewToggle({ value, onChange }) {
  return (
    <div style={{ display: 'flex', background: 'var(--s1)', border: '1px solid var(--b1)', borderRadius: 6, padding: 2 }}>
      {[
        { value: 'date', label: 'By Date' },
        { value: 'person', label: 'By Person' },
      ].map(v => (
        <button
          key={v.value}
          onClick={() => onChange(v.value)}
          style={{
            padding: '6px 12px',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            ...(value === v.value
              ? { background: 'var(--s3)', color: 'var(--text)' }
              : { background: 'transparent', color: 'var(--t3)' }),
          }}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ── Table shared styles ─────────────────────────────────────────────────────

const thStyle = {
  fontFamily: 'var(--head)',
  fontSize: 9,
  letterSpacing: '.2em',
  textTransform: 'uppercase',
  color: 'var(--t3)',
  fontWeight: 700,
  padding: '8px 8px',
  whiteSpace: 'nowrap',
};

const thStyleLeft = { ...thStyle, textAlign: 'left', padding: '8px 12px' };
const thStyleCenter = { ...thStyle, textAlign: 'center' };
const thStyleTotal = { ...thStyle, textAlign: 'center', color: 'var(--t2)', padding: '8px 12px' };

const cellStyle = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--t2)',
  textAlign: 'center',
  padding: '8px 8px',
};

const cellStyleEmpty = {
  ...cellStyle,
  color: 'var(--t3)',
};

const cellStyleLeft = {
  ...cellStyle,
  textAlign: 'left',
  padding: '8px 12px',
};

const totalCellStyle = {
  ...cellStyle,
  fontWeight: 700,
  color: 'var(--text)',
  textAlign: 'center',
  padding: '8px 12px',
};

// ── ByDateTable ──────────────────────────────────────────────────────────────

function ByDateTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <p style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>No deliverables completed in this date range.</p>;
  }

  // Pivot: group by completed_date, count per deliverable_type
  const pivot = {};
  rows.forEach(row => {
    if (!pivot[row.completed_date]) pivot[row.completed_date] = {};
    const key = row.deliverable_type || 'other';
    pivot[row.completed_date][key] = (pivot[row.completed_date][key] || 0) + 1;
  });

  const dates = Object.keys(pivot).sort((a, b) => b.localeCompare(a));

  // Column totals
  const colTotals = {};
  DEL_COLS.forEach(c => { colTotals[c.key] = 0; });
  let grandTotal = 0;

  dates.forEach(date => {
    DEL_COLS.forEach(c => {
      const val = pivot[date][c.key] || 0;
      colTotals[c.key] += val;
    });
  });
  grandTotal = Object.values(colTotals).reduce((a, b) => a + b, 0);

  return (
    <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--b1)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--s1)' }}>
            <th style={thStyleLeft}>Date</th>
            {DEL_COLS.map(c => (
              <th key={c.key} style={thStyleCenter}>{c.label}</th>
            ))}
            <th style={thStyleTotal}>Total</th>
          </tr>
        </thead>
        <tbody>
          {dates.map((date, i) => {
            const rowTotal = DEL_COLS.reduce((sum, c) => sum + (pivot[date][c.key] || 0), 0);
            return (
              <tr key={date} style={{ borderTop: '1px solid var(--b1)', ...(i % 2 !== 0 ? { background: 'var(--s1)' } : {}) }}>
                <td style={{ ...cellStyleLeft, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                  {new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                </td>
                {DEL_COLS.map(c => {
                  const val = pivot[date][c.key];
                  return (
                    <td key={c.key} style={val ? cellStyle : cellStyleEmpty}>
                      {val || '\u2014'}
                    </td>
                  );
                })}
                <td style={totalCellStyle}>{rowTotal}</td>
              </tr>
            );
          })}
          {/* Totals row */}
          <tr style={{ background: 'var(--s2)', borderTop: '2px solid var(--b2)' }}>
            <td style={{ ...cellStyleLeft, fontWeight: 700, color: 'var(--text)' }}>Totals</td>
            {DEL_COLS.map(c => {
              const val = colTotals[c.key];
              return (
                <td key={c.key} style={{ ...cellStyle, fontWeight: 700, color: 'var(--text)' }}>
                  {val || '\u2014'}
                </td>
              );
            })}
            <td style={{ ...totalCellStyle, fontWeight: 900 }}>{grandTotal}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── ByPersonTable ────────────────────────────────────────────────────────────

function ByPersonTable({ rows }) {
  const [collapsed, setCollapsed] = useState({});

  if (!rows || rows.length === 0) {
    return <p style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>No deliverables completed in this date range.</p>;
  }

  // Group by assignee_id
  const byPerson = {};
  rows.forEach(row => {
    const pid = row.assignee_id || 'unassigned';
    if (!byPerson[pid]) byPerson[pid] = { name: row.assignee_name, discipline: row.discipline, dates: {} };
    const d = byPerson[pid].dates;
    if (!d[row.completed_date]) d[row.completed_date] = {};
    const key = row.deliverable_type || 'other';
    d[row.completed_date][key] = (d[row.completed_date][key] || 0) + 1;
  });

  const personIds = Object.keys(byPerson).sort((a, b) =>
    (byPerson[a].name || '').localeCompare(byPerson[b].name || '')
  );

  function toggleCollapse(pid) {
    setCollapsed(prev => ({ ...prev, [pid]: !prev[pid] }));
  }

  return (
    <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--b1)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--s1)' }}>
            <th style={thStyleLeft}>Person / Date</th>
            {DEL_COLS.map(c => (
              <th key={c.key} style={thStyleCenter}>{c.label}</th>
            ))}
            <th style={thStyleTotal}>Total</th>
          </tr>
        </thead>
        <tbody>
          {personIds.map(pid => {
            const person = byPerson[pid];
            const dates = Object.keys(person.dates).sort((a, b) => b.localeCompare(a));
            const personTotal = dates.reduce((sum, date) =>
              sum + DEL_COLS.reduce((s, c) => s + (person.dates[date][c.key] || 0), 0), 0
            );
            const isCollapsed = collapsed[pid];

            return [
              // Person header row
              <tr
                key={`person-${pid}`}
                style={{ background: 'var(--s2)', cursor: 'pointer', borderTop: '1px solid var(--b2)' }}
                onClick={() => toggleCollapse(pid)}
              >
                <td style={{ padding: '10px 12px' }} colSpan={DEL_COLS.length + 2}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{person.name}</span>
                    {person.discipline && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'capitalize' }}>({person.discipline.replace(/_/g, ' ')})</span>
                    )}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginLeft: 'auto' }}>{personTotal} deliverable{personTotal !== 1 ? 's' : ''}</span>
                  </div>
                </td>
              </tr>,
              // Date rows (if not collapsed)
              ...(!isCollapsed ? dates.map((date, i) => {
                const rowTotal = DEL_COLS.reduce((sum, c) => sum + (person.dates[date][c.key] || 0), 0);
                return (
                  <tr key={`${pid}-${date}`} style={{ borderTop: '1px solid var(--b1)', ...(i % 2 !== 0 ? { background: 'var(--s1)' } : {}) }}>
                    <td style={{ ...cellStyleLeft, color: 'var(--t2)', whiteSpace: 'nowrap', paddingLeft: 24 }}>
                      {new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </td>
                    {DEL_COLS.map(c => {
                      const val = person.dates[date][c.key];
                      return (
                        <td key={c.key} style={val ? cellStyle : cellStyleEmpty}>
                          {val || '\u2014'}
                        </td>
                      );
                    })}
                    <td style={totalCellStyle}>{rowTotal}</td>
                  </tr>
                );
              }) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── WorkloadGrid ─────────────────────────────────────────────────────────────

const WORKLOAD_STAGES = [
  { key: 'backlog',     label: 'Backlog' },
  { key: 'in_sprint',   label: 'In Sprint' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'in_review',   label: 'In Review' },
  { key: 'ext_blocked', label: 'Ext. Blocked' },
  { key: 'done',        label: 'Done' },
  { key: 'abandoned',   label: 'Abandoned' },
];

function WorkloadGrid({ rows, highlightId }) {
  if (!rows || rows.length === 0) {
    return <p style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>No workload data for this sprint.</p>;
  }

  // Group by person, sum task_count per stage
  const byPerson = {};
  rows.forEach(r => {
    if (!byPerson[r.id]) byPerson[r.id] = { name: r.name, discipline: r.discipline, stages: {}, total: 0 };
    byPerson[r.id].stages[r.stage] = (byPerson[r.id].stages[r.stage] || 0) + r.task_count;
    byPerson[r.id].total += r.task_count;
  });

  const people = Object.entries(byPerson).map(([id, p]) => ({ ...p, id })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--b1)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--s1)' }}>
            <th style={thStyleLeft}>Person</th>
            {WORKLOAD_STAGES.map(s => (
              <th key={s.key} style={thStyleCenter}>{s.label}</th>
            ))}
            <th style={thStyleTotal}>Total</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person, i) => (
            <tr key={person.id} style={{ borderTop: '1px solid var(--b1)', opacity: highlightId && person.id !== highlightId ? 0.4 : 1, background: highlightId && person.id === highlightId ? 'var(--s3)' : (i % 2 !== 0 ? 'var(--s1)' : 'transparent') }}>
              <td style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{person.name}</span>
                  {person.discipline && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'capitalize' }}>({person.discipline.replace(/_/g, ' ')})</span>
                  )}
                </div>
              </td>
              {WORKLOAD_STAGES.map(s => {
                const val = person.stages[s.key] || 0;
                let cellColor = 'var(--t2)';
                let cellWeight = 400;
                if (s.key === 'ext_blocked' && val > 0) { cellColor = 'var(--amber)'; cellWeight = 500; }
                else if (s.key === 'done' && val > 0) { cellColor = 'var(--green)'; }
                return (
                  <td key={s.key} style={{ ...cellStyle, color: val ? cellColor : 'var(--t3)', fontWeight: cellWeight }}>
                    {val || '\u2014'}
                  </td>
                );
              })}
              <td style={{
                ...totalCellStyle,
                color: person.total > 8 ? '#f97316' : 'var(--text)',
              }}>
                {person.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── ExportCSV button ─────────────────────────────────────────────────────────

function ExportButton({ deliverables, dateRange, viewMode }) {
  function handleExport() {
    if (!deliverables || deliverables.length === 0) return;

    const colHeaders = DEL_COLS.map(c => c.label);
    let csvRows = [];

    if (viewMode === 'date') {
      // Pivot by date
      const pivot = {};
      deliverables.forEach(row => {
        if (!pivot[row.completed_date]) pivot[row.completed_date] = {};
        const key = row.deliverable_type || 'other';
        pivot[row.completed_date][key] = (pivot[row.completed_date][key] || 0) + 1;
      });
      const dates = Object.keys(pivot).sort((a, b) => b.localeCompare(a));

      csvRows.push(['Date', ...colHeaders, 'Total'].join(','));
      dates.forEach(date => {
        const vals = DEL_COLS.map(c => pivot[date][c.key] || 0);
        const total = vals.reduce((a, b) => a + b, 0);
        csvRows.push([date, ...vals, total].join(','));
      });
    } else {
      // Pivot by person
      const byPerson = {};
      deliverables.forEach(row => {
        const pid = row.assignee_id || 'unassigned';
        if (!byPerson[pid]) byPerson[pid] = { name: row.assignee_name, discipline: row.discipline || '', dates: {} };
        const d = byPerson[pid].dates;
        if (!d[row.completed_date]) d[row.completed_date] = {};
        const key = row.deliverable_type || 'other';
        d[row.completed_date][key] = (d[row.completed_date][key] || 0) + 1;
      });

      csvRows.push(['Person', 'Discipline', 'Date', ...colHeaders, 'Total'].join(','));
      Object.values(byPerson)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(person => {
          const dates = Object.keys(person.dates).sort((a, b) => b.localeCompare(a));
          dates.forEach(date => {
            const vals = DEL_COLS.map(c => person.dates[date][c.key] || 0);
            const total = vals.reduce((a, b) => a + b, 0);
            csvRows.push([`"${person.name}"`, `"${person.discipline}"`, date, ...vals, total].join(','));
          });
        });
    }

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `throttle-deliverables-${dateRange.start}-to-${dateRange.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      onClick={handleExport}
      style={{
        background: 'transparent',
        color: 'var(--t2)',
        border: '1px solid var(--b2)',
        borderRadius: 6,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        padding: '6px 12px',
        cursor: 'pointer',
      }}
    >
      Export CSV
    </button>
  );
}

// ── PersonFilter ────────────────────────────────────────────────────────────

function PersonFilter({ members, selected, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase' }}>Person</span>
      <button onClick={() => onChange(null)} style={{ background: selected === null ? '#F2CD1A' : 'var(--s2)', color: selected === null ? '#080808' : 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>All</button>
      {members.map(m => (
        <button key={m.id} onClick={() => onChange(m.id)} style={{ background: selected === m.id ? '#F2CD1A' : 'var(--s2)', color: selected === m.id ? '#080808' : 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>{m.name.split(' ')[0]}</button>
      ))}
    </div>
  );
}

// ── Main Dashboard Page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const { session, brandUser } = useAuth();

  const [allSprints, setAllSprints] = useState([]);
  const [activeSprint, setActiveSprint] = useState(null);
  const [stats, setStats] = useState(null);
  const [deliverables, setDeliverables] = useState([]);
  const [collaborations, setCollaborations] = useState([]);
  const [collabOpen, setCollabOpen] = useState(false);
  const [workload, setWorkload] = useState([]);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [deliverableView, setDeliverableView] = useState('date');
  const [drillModal, setDrillModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);

  // Load team members for person filter (admin/lead only)
  useEffect(() => {
    if (brandUser && ['admin','lead'].includes(brandUser.role) && session) {
      workerFetch('getTeamMembers', {}, session)
        .then(data => setTeamMembers(data.members || []))
        .catch(() => {});
    }
  }, [brandUser, session]);

  // Load sprints on mount
  useEffect(() => {
    if (brandUser && ['admin', 'lead'].includes(brandUser.role)) {
      loadSprints();
    } else {
      setLoading(false);
    }
  }, [brandUser]);

  async function loadSprints() {
    const { data, error } = await supabase
      .from('sprints')
      .select('*')
      .order('start_date', { ascending: false });

    if (error || !data || data.length === 0) {
      setAllSprints([]);
      setActiveSprint(null);
      setLoading(false);
      return;
    }

    setAllSprints(data);
    const active = data.find(s => s.status === 'active') || data[0];
    setActiveSprint(active);
  }

  // When activeSprint changes, load all data
  useEffect(() => {
    if (activeSprint && session) {
      const range = { start: activeSprint.start_date, end: activeSprint.end_date };
      setDateRange(range);
      setSelectedPerson(null); // Reset person filter on sprint change
      loadAllData(activeSprint.id, range, null);
    }
  }, [activeSprint, session]);

  // Re-fetch when selectedPerson changes (not on initial load)
  useEffect(() => {
    if (activeSprint && session && selectedPerson !== undefined) {
      const range = { start: activeSprint.start_date, end: activeSprint.end_date };
      loadAllData(activeSprint.id, dateRange.start ? dateRange : range, selectedPerson);
    }
  }, [selectedPerson]);

  async function loadAllData(sprintId, range, personId) {
    setLoading(true);
    try {
      const [statsData, delData, wlData] = await Promise.all([
        workerFetch('getDashboardStats', { sprintId, personId: personId || undefined }, session),
        workerFetch('getDeliverablesReport', { startDate: range.start, endDate: range.end }, session),
        workerFetch('getTeamWorkload', { sprintId }, session),
      ]);
      setStats(statsData);
      setDeliverables(delData.rows || []);
      setCollaborations(delData.collaborations || []);
      setWorkload(wlData.rows || []);
    } catch (e) {
      console.error('Dashboard load error:', e);
    }
    setLoading(false);
  }

  async function handleDateRangeChange(newRange) {
    setDateRange(newRange);
    try {
      const delData = await workerFetch('getDeliverablesReport', {
        startDate: newRange.start,
        endDate: newRange.end,
      }, session);
      setDeliverables(delData.rows || []);
      setCollaborations(delData.collaborations || []);
    } catch (e) {
      console.error('Deliverables fetch error:', e);
    }
  }

  function handleSprintChange(sprint) {
    setActiveSprint(sprint);
  }

  // Access denied for non-admin/lead
  if (!brandUser) return null;
  if (!['admin', 'lead'].includes(brandUser.role)) {
    return (
      <Layout>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: '80px 0', textAlign: 'center' }}>
          <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 8 }}>Access Restricted</h1>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>This view is for brand team managers only.</p>
        </div>
      </Layout>
    );
  }

  // No sprints found
  if (!loading && allSprints.length === 0) {
    return (
      <Layout>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: '80px 0', textAlign: 'center' }}>
          <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 8 }}>No Sprints Found</h1>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Create your first sprint to see dashboard data.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)' }}>Manager Dashboard</h1>
            {['admin','lead'].includes(brandUser?.role) && teamMembers.length > 0 && (
              <PersonFilter members={teamMembers} selected={selectedPerson} onChange={setSelectedPerson} />
            )}
          </div>
          {allSprints.length > 0 && (
            <SprintSelector
              sprints={allSprints}
              value={activeSprint?.id}
              onChange={handleSprintChange}
            />
          )}
        </div>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '.2em', textTransform: 'uppercase' }}>Loading dashboard...</p>
          </div>
        ) : (
          <>
            {/* Section 1: Summary Cards */}
            {stats && (
              <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
                <StatCard
                  label="In Review"
                  value={stats.inReview}
                  bucket="in_review"
                  color="cyan"
                  onClick={() => setDrillModal({ bucket: 'in_review', sprintId: activeSprint.id, personId: selectedPerson })}
                />
                <StatCard
                  label="Overdue"
                  value={stats.overdue}
                  bucket="overdue"
                  color="red"
                  onClick={() => setDrillModal({ bucket: 'overdue', sprintId: activeSprint.id, personId: selectedPerson })}
                />
                <StatCard
                  label="Ext. Blocked"
                  value={stats.extBlocked}
                  bucket="ext_blocked"
                  color="amber"
                  onClick={() => setDrillModal({ bucket: 'ext_blocked', sprintId: activeSprint.id, personId: selectedPerson })}
                />
                <StatCard
                  label="Completion"
                  value={`${stats.completionRate}%`}
                  bucket={null}
                  color="green"
                />
                <StatCard
                  label="Spillovers"
                  value={stats.spillovers}
                  bucket="spillovers"
                  color="orange"
                  onClick={() => setDrillModal({ bucket: 'spillovers', sprintId: activeSprint.id, personId: selectedPerson })}
                />
              </section>
            )}

            {/* Section 2: Deliverables Output */}
            {(() => {
              const visibleDeliverables = selectedPerson
                ? deliverables.filter(r => r.assignee_id === selectedPerson)
                : deliverables;
              return (
                <section>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <h2 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 13, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--text)' }}>Deliverables Output</h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <DateRangePicker
                        start={dateRange.start}
                        end={dateRange.end}
                        onChange={handleDateRangeChange}
                      />
                      <ViewToggle value={deliverableView} onChange={setDeliverableView} />
                      <ExportButton
                        deliverables={visibleDeliverables}
                        dateRange={dateRange}
                        viewMode={deliverableView}
                      />
                    </div>
                  </div>
                  {deliverableView === 'date'
                    ? <ByDateTable rows={visibleDeliverables} />
                    : <ByPersonTable rows={visibleDeliverables} />
                  }

                  {/* Collaborator footnote */}
                  {collaborations.length > 0 && (
                    <div style={{ marginTop: 16, borderTop: '1px solid var(--b1)', paddingTop: 12 }}>
                      <div
                        onClick={() => setCollabOpen(o => !o)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: collabOpen ? 10 : 0 }}
                      >
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase' }}>
                          Collaborator contributions ({collaborations.length})
                        </span>
                        <span style={{ color: 'var(--t3)', fontSize: 10 }}>{collabOpen ? '▲' : '▼'}</span>
                      </div>
                      {collabOpen && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {collaborations.map(c => (
                            <div key={`collab-${c.id}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--b1)' }}>
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', flex: 1 }}>{c.title}</span>
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginLeft: 12 }}>
                                {c.collaborators?.map(col => col.name).join(', ')}
                              </span>
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginLeft: 12, flexShrink: 0 }}>{c.completed_date}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })()}

            {/* Section 3: Team Workload */}
            <section>
              <h2 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 13, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 16 }}>Team Workload</h2>
              <WorkloadGrid rows={workload} highlightId={selectedPerson} />
            </section>
          </>
        )}

        {/* Drill-down Modal */}
        {drillModal && (
          <TaskDrillModal
            bucket={drillModal.bucket}
            sprintId={drillModal.sprintId}
            personId={drillModal.personId}
            onClose={() => setDrillModal(null)}
          />
        )}
      </div>
    </Layout>
  );
}
