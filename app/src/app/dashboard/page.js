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

const CARD_COLORS = {
  cyan:   { border: '#06b6d4', bg: 'bg-cyan-950/30' },
  red:    { border: '#ef4444', bg: 'bg-red-950/30' },
  amber:  { border: '#f59e0b', bg: 'bg-amber-950/30' },
  green:  { border: '#22c55e', bg: 'bg-green-950/30' },
  orange: { border: '#f97316', bg: 'bg-orange-950/30' },
};

function StatCard({ label, value, bucket, color, onClick }) {
  const c = CARD_COLORS[color] || CARD_COLORS.green;
  return (
    <div
      className={`${c.bg} rounded-xl p-4 border-l-4 flex flex-col justify-between min-h-20 ${
        bucket ? 'cursor-pointer hover:brightness-125 transition-all' : ''
      }`}
      style={{ borderLeftColor: c.border }}
      onClick={bucket ? onClick : undefined}
    >
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-zinc-400 mt-1">{label}</div>
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
      className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none"
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

  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={localStart}
        onChange={e => setLocalStart(e.target.value)}
        className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 focus:outline-none"
      />
      <span className="text-zinc-600 text-xs">to</span>
      <input
        type="date"
        value={localEnd}
        onChange={e => setLocalEnd(e.target.value)}
        className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 focus:outline-none"
      />
      <button
        onClick={handleApply}
        className="bg-zinc-800 text-zinc-300 text-xs px-3 py-1.5 rounded-lg hover:bg-zinc-700 transition-colors"
      >
        Apply
      </button>
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </div>
  );
}

// ── ViewToggle ───────────────────────────────────────────────────────────────

function ViewToggle({ value, onChange }) {
  return (
    <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
      {[
        { value: 'date', label: 'By Date' },
        { value: 'person', label: 'By Person' },
      ].map(v => (
        <button
          key={v.value}
          onClick={() => onChange(v.value)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            value === v.value
              ? 'bg-zinc-700 text-white'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ── ByDateTable ──────────────────────────────────────────────────────────────

function ByDateTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="text-zinc-600 text-sm py-10 text-center">No deliverables completed in this date range.</p>;
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
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full">
        <thead className="bg-zinc-900">
          <tr>
            <th className="text-left text-xs text-zinc-500 font-medium px-3 py-2">Date</th>
            {DEL_COLS.map(c => (
              <th key={c.key} className="text-center text-xs text-zinc-500 font-medium px-2 py-2 whitespace-nowrap">{c.label}</th>
            ))}
            <th className="text-center text-xs text-zinc-400 font-semibold px-3 py-2">Total</th>
          </tr>
        </thead>
        <tbody>
          {dates.map((date, i) => {
            const rowTotal = DEL_COLS.reduce((sum, c) => sum + (pivot[date][c.key] || 0), 0);
            return (
              <tr key={date} className={`border-t border-zinc-800 ${i % 2 === 0 ? '' : 'bg-zinc-900/30'}`}>
                <td className="px-3 py-2 text-zinc-300 text-xs whitespace-nowrap">
                  {new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                </td>
                {DEL_COLS.map(c => (
                  <td key={c.key} className="text-center px-2 py-2 text-xs text-zinc-400">
                    {pivot[date][c.key] || '—'}
                  </td>
                ))}
                <td className="text-center px-3 py-2 text-xs text-zinc-200 font-medium">{rowTotal}</td>
              </tr>
            );
          })}
          {/* Totals row */}
          <tr className="border-t-2 border-zinc-700 bg-zinc-900">
            <td className="px-3 py-2 text-xs text-zinc-300 font-semibold">Totals</td>
            {DEL_COLS.map(c => (
              <td key={c.key} className="text-center px-2 py-2 text-xs text-zinc-300 font-medium">
                {colTotals[c.key] || '—'}
              </td>
            ))}
            <td className="text-center px-3 py-2 text-xs text-white font-bold">{grandTotal}</td>
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
    return <p className="text-zinc-600 text-sm py-10 text-center">No deliverables completed in this date range.</p>;
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
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full">
        <thead className="bg-zinc-900">
          <tr>
            <th className="text-left text-xs text-zinc-500 font-medium px-3 py-2">Person / Date</th>
            {DEL_COLS.map(c => (
              <th key={c.key} className="text-center text-xs text-zinc-500 font-medium px-2 py-2 whitespace-nowrap">{c.label}</th>
            ))}
            <th className="text-center text-xs text-zinc-400 font-semibold px-3 py-2">Total</th>
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
                className="bg-zinc-800/50 cursor-pointer hover:bg-zinc-800 transition-colors border-t border-zinc-700"
                onClick={() => toggleCollapse(pid)}
              >
                <td className="px-3 py-2.5" colSpan={DEL_COLS.length + 2}>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500 text-xs">{isCollapsed ? '▶' : '▼'}</span>
                    <span className="text-zinc-200 text-xs font-semibold">{person.name}</span>
                    {person.discipline && (
                      <span className="text-zinc-600 text-xs capitalize">({person.discipline.replace(/_/g, ' ')})</span>
                    )}
                    <span className="text-zinc-500 text-xs ml-auto">{personTotal} deliverable{personTotal !== 1 ? 's' : ''}</span>
                  </div>
                </td>
              </tr>,
              // Date rows (if not collapsed)
              ...(!isCollapsed ? dates.map((date, i) => {
                const rowTotal = DEL_COLS.reduce((sum, c) => sum + (person.dates[date][c.key] || 0), 0);
                return (
                  <tr key={`${pid}-${date}`} className={`border-t border-zinc-800 ${i % 2 === 0 ? '' : 'bg-zinc-900/30'}`}>
                    <td className="px-6 py-2 text-zinc-400 text-xs whitespace-nowrap">
                      {new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </td>
                    {DEL_COLS.map(c => (
                      <td key={c.key} className="text-center px-2 py-2 text-xs text-zinc-400">
                        {person.dates[date][c.key] || '—'}
                      </td>
                    ))}
                    <td className="text-center px-3 py-2 text-xs text-zinc-200 font-medium">{rowTotal}</td>
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

function WorkloadGrid({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="text-zinc-600 text-sm py-10 text-center">No workload data for this sprint.</p>;
  }

  // Group by person, sum task_count per stage
  const byPerson = {};
  rows.forEach(r => {
    if (!byPerson[r.id]) byPerson[r.id] = { name: r.name, discipline: r.discipline, stages: {}, total: 0 };
    byPerson[r.id].stages[r.stage] = (byPerson[r.id].stages[r.stage] || 0) + r.task_count;
    byPerson[r.id].total += r.task_count;
  });

  const people = Object.values(byPerson).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full">
        <thead className="bg-zinc-900">
          <tr>
            <th className="text-left text-xs text-zinc-500 font-medium px-3 py-2">Person</th>
            {WORKLOAD_STAGES.map(s => (
              <th key={s.key} className="text-center text-xs text-zinc-500 font-medium px-2 py-2 whitespace-nowrap">{s.label}</th>
            ))}
            <th className="text-center text-xs text-zinc-400 font-semibold px-3 py-2">Total</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person, i) => (
            <tr key={person.name} className={`border-t border-zinc-800 ${i % 2 === 0 ? '' : 'bg-zinc-900/30'}`}>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-200 text-xs font-medium">{person.name}</span>
                  {person.discipline && (
                    <span className="text-zinc-600 text-xs capitalize">({person.discipline.replace(/_/g, ' ')})</span>
                  )}
                </div>
              </td>
              {WORKLOAD_STAGES.map(s => {
                const val = person.stages[s.key] || 0;
                let cellClass = 'text-center px-2 py-2.5 text-xs ';
                if (s.key === 'ext_blocked' && val > 0) cellClass += 'text-amber-400 font-medium';
                else if (s.key === 'done' && val > 0) cellClass += 'text-green-400';
                else cellClass += 'text-zinc-400';
                return (
                  <td key={s.key} className={cellClass}>
                    {val || '—'}
                  </td>
                );
              })}
              <td className={`text-center px-3 py-2.5 text-xs font-medium ${
                person.total > 8 ? 'text-orange-400' : 'text-zinc-200'
              }`}>
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
      className="bg-zinc-800 text-zinc-300 text-xs px-3 py-1.5 rounded-lg hover:bg-zinc-700 transition-colors"
    >
      Export CSV
    </button>
  );
}

// ── Main Dashboard Page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const { session, brandUser } = useAuth();

  const [allSprints, setAllSprints] = useState([]);
  const [activeSprint, setActiveSprint] = useState(null);
  const [stats, setStats] = useState(null);
  const [deliverables, setDeliverables] = useState([]);
  const [workload, setWorkload] = useState([]);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [deliverableView, setDeliverableView] = useState('date');
  const [drillModal, setDrillModal] = useState(null);
  const [loading, setLoading] = useState(true);

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
      loadAllData(activeSprint.id, range);
    }
  }, [activeSprint, session]);

  async function loadAllData(sprintId, range) {
    setLoading(true);
    try {
      const [statsData, delData, wlData] = await Promise.all([
        workerFetch('getDashboardStats', { sprintId }, session),
        workerFetch('getDeliverablesReport', { startDate: range.start, endDate: range.end }, session),
        workerFetch('getTeamWorkload', { sprintId }, session),
      ]);
      setStats(statsData);
      setDeliverables(delData.rows || []);
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
        <div className="max-w-2xl mx-auto py-20 text-center">
          <h1 className="text-xl font-bold text-white mb-2">Access Restricted</h1>
          <p className="text-zinc-600 text-sm">This view is for brand team managers only.</p>
        </div>
      </Layout>
    );
  }

  // No sprints found
  if (!loading && allSprints.length === 0) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto py-20 text-center">
          <h1 className="text-xl font-bold text-white mb-2">No Sprints Found</h1>
          <p className="text-zinc-600 text-sm">Create your first sprint to see dashboard data.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">Manager Dashboard</h1>
          {allSprints.length > 0 && (
            <SprintSelector
              sprints={allSprints}
              value={activeSprint?.id}
              onChange={handleSprintChange}
            />
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-zinc-600 text-sm">Loading dashboard...</p>
          </div>
        ) : (
          <>
            {/* Section 1: Summary Cards */}
            {stats && (
              <section className="grid grid-cols-5 gap-3">
                <StatCard
                  label="In Review"
                  value={stats.inReview}
                  bucket="in_review"
                  color="cyan"
                  onClick={() => setDrillModal({ bucket: 'in_review', sprintId: activeSprint.id })}
                />
                <StatCard
                  label="Overdue"
                  value={stats.overdue}
                  bucket="overdue"
                  color="red"
                  onClick={() => setDrillModal({ bucket: 'overdue', sprintId: activeSprint.id })}
                />
                <StatCard
                  label="Ext. Blocked"
                  value={stats.extBlocked}
                  bucket="ext_blocked"
                  color="amber"
                  onClick={() => setDrillModal({ bucket: 'ext_blocked', sprintId: activeSprint.id })}
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
                  onClick={() => setDrillModal({ bucket: 'spillovers', sprintId: activeSprint.id })}
                />
              </section>
            )}

            {/* Section 2: Deliverables Output */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Deliverables Output</h2>
                <div className="flex items-center gap-3">
                  <DateRangePicker
                    start={dateRange.start}
                    end={dateRange.end}
                    onChange={handleDateRangeChange}
                  />
                  <ViewToggle value={deliverableView} onChange={setDeliverableView} />
                  <ExportButton
                    deliverables={deliverables}
                    dateRange={dateRange}
                    viewMode={deliverableView}
                  />
                </div>
              </div>
              {deliverableView === 'date'
                ? <ByDateTable rows={deliverables} />
                : <ByPersonTable rows={deliverables} />
              }
            </section>

            {/* Section 3: Team Workload */}
            <section>
              <h2 className="text-lg font-semibold text-white mb-4">Team Workload</h2>
              <WorkloadGrid rows={workload} />
            </section>
          </>
        )}

        {/* Drill-down Modal */}
        {drillModal && (
          <TaskDrillModal
            bucket={drillModal.bucket}
            sprintId={drillModal.sprintId}
            onClose={() => setDrillModal(null)}
          />
        )}
      </div>
    </Layout>
  );
}
