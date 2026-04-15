'use client';
import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { getPriorityConfig, getStageConfig } from '@/lib/taskConfig';
import {
  getNextThursday, getSprintEndDate, toDateString,
  generateSprintName, getSprintDays, taskDueOnDay,
  getSprintStatusLabel, isThursday
} from '@/lib/sprintUtils';

// ── Sprint Timeline ───────────────────────────────────────────────────────────

function SprintTimeline({ sprint, sprintTasks }) {
  if (!sprint) return null;
  const days = getSprintDays(sprint.start_date);
  const DAY_LABELS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-6">
      <p className="text-xs text-zinc-600 uppercase tracking-widest mb-3">Sprint Timeline</p>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day, i) => {
          const dayDate = new Date(day);
          dayDate.setHours(0, 0, 0, 0);
          const isToday = dayDate.getTime() === today.getTime();
          const isPast = dayDate < today;
          const dueTasks = sprintTasks.filter(t => taskDueOnDay(t, day));

          return (
            <div
              key={i}
              className={`rounded-lg p-2 min-h-20 ${
                isToday
                  ? 'bg-zinc-700 border border-zinc-500'
                  : isPast
                  ? 'bg-zinc-900/50'
                  : 'bg-zinc-800/50'
              }`}
            >
              {/* Day header */}
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-xs font-medium ${isToday ? 'text-white' : 'text-zinc-500'}`}>
                  {DAY_LABELS[i]}
                </span>
                <span className={`text-xs ${isToday ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {dayDate.getDate()}
                </span>
              </div>

              {/* Tasks due this day */}
              <div className="space-y-1">
                {dueTasks.map(task => {
                  const priority = getPriorityConfig(task.priority);
                  return (
                    <div
                      key={task.id}
                      className="rounded px-1 py-0.5"
                      style={{ backgroundColor: priority.color + '22', borderLeft: `2px solid ${priority.color}` }}
                    >
                      <p className="text-xs text-zinc-300 truncate leading-tight" title={task.title}>
                        {task.title}
                      </p>
                    </div>
                  );
                })}
                {dueTasks.length === 0 && (
                  <div className="h-3" /> // empty spacer
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* No due dates note */}
      {sprintTasks.filter(t => t.due_date).length === 0 && (
        <p className="text-zinc-700 text-xs mt-2 text-center">
          No due dates set — assign due dates to tasks to see them here
        </p>
      )}
    </div>
  );
}

// ── Task Row (for sprint and backlog lists) ───────────────────────────────────

function TaskRow({ task, actions }) {
  const priority = getPriorityConfig(task.priority);
  const stage = getStageConfig(task.stage);

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 hover:bg-zinc-800/50 rounded-lg group transition-colors">
      <span
        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: priority.color }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-zinc-200 text-xs font-medium truncate">{task.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {task.product_code && (
            <span className="text-zinc-700 text-xs">{task.product_code}</span>
          )}
          <span className="text-zinc-700 text-xs">{stage.label}</span>
          {task.is_spillover && (
            <span className="text-amber-500 text-xs">↩ spillover</span>
          )}
        </div>
      </div>
      {task.due_date && (
        <span className="text-zinc-600 text-xs flex-shrink-0">
          {new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
      )}
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {actions}
      </div>
    </div>
  );
}

// ── Main Sprint Page ──────────────────────────────────────────────────────────

export default function SprintsPage() {
  const { session, brandUser } = useAuth();
  const [activeSprint, setActiveSprint] = useState(null);
  const [sprintTasks, setSprintTasks] = useState([]);
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dragOverSprint, setDragOverSprint] = useState(false);
  const [dragOverBacklog, setDragOverBacklog] = useState(false);
  const [error, setError] = useState(null);

  // Create sprint form
  const [showCreate, setShowCreate] = useState(false);
  const [newSprintDate, setNewSprintDate] = useState(() => {
    const next = getNextThursday();
    return toDateString(next);
  });
  const [creating, setCreating] = useState(false);

  // Due date modal
  const [pendingAdd, setPendingAdd] = useState(null); // { task, sprint_id }
  const [dueDate, setDueDate] = useState('');

  // Close sprint
  const [closing, setClosing] = useState(false);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);

  useEffect(() => {
    if (brandUser) loadAll();
  }, [brandUser]);

  async function loadAll() {
    setLoading(true);
    await Promise.all([loadActiveSprint(), loadBacklog()]);
    setLoading(false);
  }

  async function loadActiveSprint() {
    const { data: sprints } = await supabase
      .from('sprints')
      .select('*')
      .eq('status', 'active')
      .limit(1);

    const sprint = sprints?.[0] || null;
    setActiveSprint(sprint);

    if (sprint) {
      const { data: tasks } = await supabase
        .from('tasks')
        .select('*')
        .eq('sprint_id', sprint.id)
        .not('stage', 'in', '("done","abandoned")')
        .order('created_at', { ascending: false });
      setSprintTasks(tasks || []);
    } else {
      setSprintTasks([]);
    }
  }

  async function loadBacklog() {
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .eq('stage', 'backlog')
      .is('sprint_id', null)
      .order('created_at', { ascending: false });
    setBacklogTasks(data || []);
  }

  async function createSprint() {
    if (!isThursday(newSprintDate)) {
      setError('Sprint must start on a Thursday');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await workerFetch('createSprint', { start_date: newSprintDate }, session?.access_token);
      setShowCreate(false);
      await loadActiveSprint();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function addToSprint(task, sprint_id, due_date) {
    setError(null);
    try {
      await workerFetch('addTaskToSprint', {
        task_id: task.id,
        sprint_id,
        due_date: due_date || undefined,
      }, session?.access_token);
      setBacklogTasks(prev => prev.filter(t => t.id !== task.id));
      setSprintTasks(prev => [...prev, { ...task, sprint_id, stage: 'in_sprint', due_date: due_date || null }]);
      setPendingAdd(null);
      setDueDate('');
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeFromSprint(task) {
    setError(null);
    try {
      await workerFetch('removeTaskFromSprint', { task_id: task.id }, session?.access_token);
      setSprintTasks(prev => prev.filter(t => t.id !== task.id));
      setBacklogTasks(prev => [{ ...task, stage: 'backlog', sprint_id: null }, ...prev]);
    } catch (e) {
      setError(e.message);
    }
  }

  async function closeSprint() {
    if (!activeSprint) return;
    if (!confirm(`Close "${activeSprint.name}"? Incomplete tasks will become spillovers and a new sprint will be created automatically.`)) return;
    setClosing(true);
    setError(null);
    try {
      await workerFetch('closeSprint', { sprint_id: activeSprint.id }, session?.access_token);
      await loadAll();
    } catch (e) {
      setError(e.message);
    } finally {
      setClosing(false);
    }
  }

  // Drag handlers
  function handleDragFromBacklog(e, task) {
    e.dataTransfer.setData('taskId', task.id);
    e.dataTransfer.setData('taskJson', JSON.stringify(task));
    e.dataTransfer.setData('source', 'backlog');
  }

  function handleDragFromSprint(e, task) {
    e.dataTransfer.setData('taskId', task.id);
    e.dataTransfer.setData('taskJson', JSON.stringify(task));
    e.dataTransfer.setData('source', 'sprint');
  }

  function handleDropToSprint(e) {
    e.preventDefault();
    setDragOverSprint(false);
    const source = e.dataTransfer.getData('source');
    if (source !== 'backlog') return;
    const task = JSON.parse(e.dataTransfer.getData('taskJson'));
    if (!activeSprint) return;
    // Ask for due date
    setPendingAdd({ task, sprint_id: activeSprint.id });
    setDueDate('');
  }

  function handleDropToBacklog(e) {
    e.preventDefault();
    setDragOverBacklog(false);
    const source = e.dataTransfer.getData('source');
    if (source !== 'sprint') return;
    const task = JSON.parse(e.dataTransfer.getData('taskJson'));
    removeFromSprint(task);
  }

  // Filter backlog
  const filteredBacklog = backlogTasks.filter(t =>
    !search || t.title.toLowerCase().includes(search.toLowerCase())
      || t.product_code?.toLowerCase().includes(search.toLowerCase())
  );

  const statusLabel = getSprintStatusLabel(activeSprint);

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Sprints</h1>
            <p className="text-zinc-500 text-sm mt-1">
              {activeSprint ? activeSprint.name : 'No active sprint'}
            </p>
          </div>

          {isAdminLead && (
            <div className="flex gap-3">
              {activeSprint && (
                <button
                  onClick={closeSprint}
                  disabled={closing}
                  className="bg-zinc-800 text-zinc-300 text-sm font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors disabled:opacity-40"
                >
                  {closing ? 'Closing...' : 'Close Sprint'}
                </button>
              )}
              {!activeSprint && (
                <button
                  onClick={() => setShowCreate(true)}
                  className="bg-white text-black font-semibold px-4 py-2 rounded-lg text-sm hover:bg-zinc-100 transition-colors"
                >
                  + Create Sprint
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 mb-5">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Create sprint form */}
        {showCreate && isAdminLead && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
            <h2 className="text-white font-semibold mb-4">Create Sprint</h2>
            <div className="flex gap-4 items-end">
              <div className="flex-1">
                <label className="block text-xs text-zinc-500 mb-1.5">
                  Start Date (must be a Thursday)
                </label>
                <input
                  type="date"
                  value={newSprintDate}
                  onChange={e => setNewSprintDate(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={createSprint}
                  disabled={creating}
                  className="bg-white text-black font-semibold px-5 py-2 rounded-lg text-sm hover:bg-zinc-100 transition-colors disabled:opacity-40"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  className="text-zinc-600 text-sm hover:text-zinc-400 px-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-20 text-center">
            <p className="text-zinc-600 text-sm">Loading...</p>
          </div>
        ) : (
          <>
            {/* Sprint timeline */}
            {activeSprint && (
              <SprintTimeline sprint={activeSprint} sprintTasks={sprintTasks} />
            )}

            {/* Split: Sprint tasks + Backlog */}
            <div className="grid grid-cols-2 gap-5">

              {/* Current Sprint */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      {activeSprint ? 'Current Sprint' : 'No Active Sprint'}
                    </h2>
                    {activeSprint && (
                      <p className="text-xs text-zinc-600 mt-0.5">{statusLabel}</p>
                    )}
                  </div>
                  <span className="text-xs text-zinc-700 bg-zinc-800 px-2 py-0.5 rounded">
                    {sprintTasks.length}
                  </span>
                </div>

                <div
                  onDragOver={e => { if (isAdminLead && activeSprint) { e.preventDefault(); setDragOverSprint(true); } }}
                  onDragLeave={() => setDragOverSprint(false)}
                  onDrop={handleDropToSprint}
                  className={`min-h-48 rounded-xl border transition-colors ${
                    dragOverSprint
                      ? 'border-dashed border-zinc-500 bg-zinc-800/50'
                      : 'border-zinc-800 bg-zinc-900/30'
                  } p-2`}
                >
                  {!activeSprint ? (
                    <div className="flex items-center justify-center h-full py-10">
                      <p className="text-zinc-700 text-xs text-center">
                        {isAdminLead ? 'Create a sprint to get started' : 'No active sprint'}
                      </p>
                    </div>
                  ) : sprintTasks.length === 0 ? (
                    <div className="flex items-center justify-center h-full py-10">
                      <p className="text-zinc-700 text-xs">
                        {isAdminLead ? 'Drag tasks here from the backlog' : 'No tasks in sprint'}
                      </p>
                    </div>
                  ) : (
                    sprintTasks.map(task => (
                      <div
                        key={task.id}
                        draggable={isAdminLead}
                        onDragStart={e => handleDragFromSprint(e, task)}
                      >
                        <TaskRow
                          task={task}
                          actions={isAdminLead ? (
                            <button
                              onClick={() => removeFromSprint(task)}
                              className="text-zinc-700 hover:text-red-400 text-xs transition-colors"
                              title="Remove from sprint"
                            >
                              ✕
                            </button>
                          ) : null}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Backlog */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-white">Backlog</h2>
                  <span className="text-xs text-zinc-700 bg-zinc-800 px-2 py-0.5 rounded">
                    {filteredBacklog.length}
                  </span>
                </div>

                {/* Search */}
                <input
                  type="text"
                  placeholder="Search backlog..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none mb-3"
                />

                <div
                  onDragOver={e => { if (isAdminLead) { e.preventDefault(); setDragOverBacklog(true); } }}
                  onDragLeave={() => setDragOverBacklog(false)}
                  onDrop={handleDropToBacklog}
                  className={`min-h-48 rounded-xl border transition-colors overflow-y-auto max-h-96 ${
                    dragOverBacklog
                      ? 'border-dashed border-zinc-500 bg-zinc-800/50'
                      : 'border-zinc-800 bg-zinc-900/30'
                  } p-2`}
                >
                  {filteredBacklog.length === 0 ? (
                    <div className="flex items-center justify-center h-full py-10">
                      <p className="text-zinc-700 text-xs">
                        {search ? 'No matching tasks' : 'Backlog is empty'}
                      </p>
                    </div>
                  ) : (
                    filteredBacklog.map(task => (
                      <div
                        key={task.id}
                        draggable={isAdminLead && !!activeSprint}
                        onDragStart={e => handleDragFromBacklog(e, task)}
                        className={isAdminLead && activeSprint ? 'cursor-grab active:cursor-grabbing' : ''}
                      >
                        <TaskRow
                          task={task}
                          actions={isAdminLead && activeSprint ? (
                            <button
                              onClick={() => setPendingAdd({ task, sprint_id: activeSprint.id })}
                              className="text-zinc-700 hover:text-green-400 text-xs transition-colors"
                              title="Add to sprint"
                            >
                              + Add
                            </button>
                          ) : null}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Due date modal */}
        {pendingAdd && (
          <>
            <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setPendingAdd(null)} />
            <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-zinc-900 border border-zinc-700 rounded-xl p-6 z-50 w-80">
              <h3 className="text-white font-semibold mb-1">Add to Sprint</h3>
              <p className="text-zinc-500 text-xs mb-4 truncate">{pendingAdd.task.title}</p>
              <div className="mb-4">
                <label className="block text-xs text-zinc-500 mb-1.5">Due Date (optional)</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  min={activeSprint?.start_date}
                  max={activeSprint?.end_date}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => addToSprint(pendingAdd.task, pendingAdd.sprint_id, dueDate)}
                  className="flex-1 bg-white text-black font-semibold py-2 rounded-lg text-sm hover:bg-zinc-100 transition-colors"
                >
                  Add to Sprint
                </button>
                <button
                  onClick={() => { setPendingAdd(null); setDueDate(''); }}
                  className="text-zinc-600 text-sm px-4 hover:text-zinc-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
