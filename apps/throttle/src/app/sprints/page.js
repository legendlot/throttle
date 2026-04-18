'use client';
import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import { supabaseBrand as supabase, workerFetch } from '@throttle/db';
import { useAuth } from '@throttle/auth';
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
    <div style={{ background: 'var(--s1)', border: '1px solid var(--b1)', borderRadius: 6, padding: 16, marginBottom: 24 }}>
      <p style={{ fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 12 }}>Sprint Timeline</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {days.map((day, i) => {
          const dayDate = new Date(day);
          dayDate.setHours(0, 0, 0, 0);
          const isToday = dayDate.getTime() === today.getTime();
          const isPast = dayDate < today;
          const dueTasks = sprintTasks.filter(t => taskDueOnDay(t, day));

          const cellStyle = isToday
            ? { background: 'var(--s3)', border: '1px solid var(--b3)', borderRadius: 6, padding: 8, minHeight: 80 }
            : isPast
            ? { background: 'var(--s1)', borderRadius: 6, padding: 8, minHeight: 80 }
            : { background: 'var(--s2)', borderRadius: 6, padding: 8, minHeight: 80 };

          return (
            <div key={i} style={cellStyle}>
              {/* Day header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 500, color: isToday ? 'var(--text)' : 'var(--t3)' }}>
                  {DAY_LABELS[i]}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: isToday ? 'var(--t2)' : 'var(--b2)' }}>
                  {dayDate.getDate()}
                </span>
              </div>

              {/* Tasks due this day */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dueTasks.map(task => {
                  const priority = getPriorityConfig(task.priority);
                  return (
                    <div
                      key={task.id}
                      style={{ borderRadius: 3, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, backgroundColor: priority.color + '22', borderLeft: `2px solid ${priority.color}` }}
                    >
                      <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }} title={task.title}>
                        {task.title}
                      </p>
                    </div>
                  );
                })}
                {dueTasks.length === 0 && (
                  <div style={{ height: 12 }} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* No due dates note */}
      {sprintTasks.filter(t => t.due_date).length === 0 && (
        <p style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10, marginTop: 8, textAlign: 'center' }}>
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
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
        borderRadius: 6, transition: 'background 0.15s',
        background: hovered ? 'var(--s2)' : 'transparent'
      }}
    >
      <span
        style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0, backgroundColor: priority.color }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          {task.product_code && (
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10 }}>{task.product_code}</span>
          )}
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10 }}>{stage.label}</span>
          {task.is_spillover && (
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--amber)', fontSize: 10 }}>↩ spillover</span>
          )}
        </div>
      </div>
      {task.due_date && (
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--t3)', fontSize: 10, flexShrink: 0 }}>
          {new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s', flexShrink: 0 }}>
        {actions}
      </div>
    </div>
  );
}

// ── Remove / Add action buttons ──────────────────────────────────────────────

function RemoveButton({ onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ fontFamily: 'var(--mono)', fontSize: 11, color: hovered ? 'var(--red)' : 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.15s' }}
      title="Remove from sprint"
    >
      ✕
    </button>
  );
}

function AddButton({ onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ fontFamily: 'var(--mono)', fontSize: 11, color: hovered ? 'var(--green)' : 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.15s' }}
      title="Add to sprint"
    >
      + Add
    </button>
  );
}

// ── Person Filter ────────────────────────────────────────────────────────────

function PersonFilter({ members, selected, onChange, taskCounts }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase' }}>Person</span>
      <button onClick={() => onChange(null)} style={{ background: selected === null ? '#F2CD1A' : 'var(--s2)', color: selected === null ? '#080808' : 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>All</button>
      {members.map(m => (
        <button key={m.id} onClick={() => onChange(m.id)} style={{ background: selected === m.id ? '#F2CD1A' : 'var(--s2)', color: selected === m.id ? '#080808' : 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
          {m.name.split(' ')[0]}{taskCounts && taskCounts[m.id] ? ` (${taskCounts[m.id]})` : ''}
        </button>
      ))}
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
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);

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

  // Search focus
  const [searchFocused, setSearchFocused] = useState(false);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);

  useEffect(() => {
    if (brandUser) loadAll();
  }, [brandUser]);

  useEffect(() => {
    if (isAdminLead && session) {
      workerFetch('getTeamMembers', {}, session?.access_token)
        .then(data => setTeamMembers(data.members || []))
        .catch(() => {});
    }
  }, [isAdminLead, session]);

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
        .select('*, task_assignees(user_id, is_owner)')
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
      .select('*, task_assignees(user_id, is_owner)')
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

  // Person filtering
  const filteredSprintTasks = selectedPerson
    ? sprintTasks.filter(t => t.task_assignees?.some(a => a.user_id === selectedPerson))
    : sprintTasks;
  const filteredBacklog = (selectedPerson
    ? backlogTasks.filter(t => t.task_assignees?.some(a => a.user_id === selectedPerson))
    : backlogTasks
  ).filter(t => !search || t.title.toLowerCase().includes(search.toLowerCase()) || t.product_code?.toLowerCase().includes(search.toLowerCase()));

  // Task counts per person
  const personTaskCounts = {};
  teamMembers.forEach(m => {
    personTaskCounts[m.id] = sprintTasks.filter(t => t.task_assignees?.some(a => a.user_id === m.id)).length;
  });

  const statusLabel = getSprintStatusLabel(activeSprint);

  return (
    <Layout>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)', margin: 0 }}>Sprints</h1>
            <p style={{ fontFamily: 'var(--mono)', color: 'var(--t3)', fontSize: 11, marginTop: 4 }}>
              {activeSprint ? activeSprint.name : 'No active sprint'}
            </p>
            {isAdminLead && teamMembers.length > 0 && (
              <PersonFilter members={teamMembers} selected={selectedPerson} onChange={setSelectedPerson} taskCounts={personTaskCounts} />
            )}
          </div>

          {isAdminLead && (
            <div style={{ display: 'flex', gap: 12 }}>
              {activeSprint && (
                <button
                  onClick={closeSprint}
                  disabled={closing}
                  style={{
                    background: 'transparent', color: 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 6,
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
                    padding: '8px 16px', cursor: 'pointer', opacity: closing ? 0.4 : 1, transition: 'opacity 0.15s'
                  }}
                >
                  {closing ? 'Closing...' : 'Close Sprint'}
                </button>
              )}
              {!activeSprint && (
                <button
                  onClick={() => setShowCreate(true)}
                  style={{
                    background: '#F2CD1A', color: '#080808', fontFamily: 'var(--head)', fontWeight: 700,
                    fontSize: 11, letterSpacing: '.15em', textTransform: 'uppercase',
                    borderRadius: 6, border: 'none', padding: '8px 16px', cursor: 'pointer'
                  }}
                >
                  + Create Sprint
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ background: 'rgba(222,42,42,0.08)', border: '1px solid rgba(222,42,42,0.3)', borderRadius: 6, padding: '12px 16px', marginBottom: 20 }}>
            <p style={{ fontFamily: 'var(--mono)', color: 'var(--red)', fontSize: 11, margin: 0 }}>{error}</p>
          </div>
        )}

        {/* Create sprint form */}
        {showCreate && isAdminLead && (
          <div style={{ background: 'var(--s1)', border: '1px solid var(--b1)', borderRadius: 6, padding: 20, marginBottom: 24 }}>
            <h2 style={{ fontFamily: 'var(--head)', fontSize: 13, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text)', margin: 0, marginBottom: 16 }}>Create Sprint</h2>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>
                  Start Date (must be a Thursday)
                </label>
                <input
                  type="date"
                  value={newSprintDate}
                  onChange={e => setNewSprintDate(e.target.value)}
                  style={{
                    width: '100%', boxSizing: 'border-box', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6,
                    padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={createSprint}
                  disabled={creating}
                  style={{
                    background: '#F2CD1A', color: '#080808', fontFamily: 'var(--head)', fontWeight: 700,
                    fontSize: 11, letterSpacing: '.15em', textTransform: 'uppercase',
                    borderRadius: 6, border: 'none', padding: '8px 20px', cursor: 'pointer',
                    opacity: creating ? 0.4 : 1
                  }}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ padding: '80px 0', textAlign: 'center' }}>
            <p style={{ fontFamily: 'var(--mono)', color: 'var(--t3)', fontSize: 11 }}>Loading...</p>
          </div>
        ) : (
          <>
            {/* Sprint timeline */}
            {activeSprint && (
              <SprintTimeline sprint={activeSprint} sprintTasks={sprintTasks} />
            )}

            {/* Split: Sprint tasks + Backlog */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

              {/* Current Sprint */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div>
                    <h2 style={{ fontFamily: 'var(--head)', fontSize: 13, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text)', margin: 0 }}>
                      {activeSprint ? 'Current Sprint' : 'No Active Sprint'}
                    </h2>
                    {activeSprint && (
                      <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{statusLabel}</p>
                    )}
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, background: 'var(--s2)', color: 'var(--t3)', padding: '2px 6px', borderRadius: 3 }}>
                    {filteredSprintTasks.length}
                  </span>
                </div>

                <div
                  onDragOver={e => { if (isAdminLead && activeSprint) { e.preventDefault(); setDragOverSprint(true); } }}
                  onDragLeave={() => setDragOverSprint(false)}
                  onDrop={handleDropToSprint}
                  style={{
                    minHeight: 192, borderRadius: 6, transition: 'background 0.15s, border-color 0.15s', padding: 8,
                    ...(dragOverSprint
                      ? { border: '1px dashed var(--b3)', background: 'var(--s2)' }
                      : { border: '1px solid var(--b1)', background: 'var(--s1)' }
                    )
                  }}
                >
                  {!activeSprint ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 0' }}>
                      <p style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10, textAlign: 'center' }}>
                        {isAdminLead ? 'Create a sprint to get started' : 'No active sprint'}
                      </p>
                    </div>
                  ) : filteredSprintTasks.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 0' }}>
                      <p style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10 }}>
                        {isAdminLead ? 'Drag tasks here from the backlog' : 'No tasks in sprint'}
                      </p>
                    </div>
                  ) : (
                    filteredSprintTasks.map(task => (
                      <div
                        key={task.id}
                        draggable={isAdminLead}
                        onDragStart={e => handleDragFromSprint(e, task)}
                      >
                        <TaskRow
                          task={task}
                          actions={isAdminLead ? (
                            <RemoveButton onClick={() => removeFromSprint(task)} />
                          ) : null}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Backlog */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h2 style={{ fontFamily: 'var(--head)', fontSize: 13, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text)', margin: 0 }}>Backlog</h2>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, background: 'var(--s2)', color: 'var(--t3)', padding: '2px 6px', borderRadius: 3 }}>
                    {filteredBacklog.length}
                  </span>
                </div>

                {/* Search */}
                <input
                  type="text"
                  placeholder="Search backlog..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  style={{
                    width: '100%', boxSizing: 'border-box', background: 'var(--s2)',
                    border: searchFocused ? '1px solid var(--yellow)' : '1px solid var(--b2)',
                    borderRadius: 6, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                    color: 'var(--text)', outline: 'none', marginBottom: 12
                  }}
                />

                <div
                  onDragOver={e => { if (isAdminLead) { e.preventDefault(); setDragOverBacklog(true); } }}
                  onDragLeave={() => setDragOverBacklog(false)}
                  onDrop={handleDropToBacklog}
                  style={{
                    minHeight: 192, borderRadius: 6, transition: 'background 0.15s, border-color 0.15s',
                    overflowY: 'auto', maxHeight: 384, padding: 8,
                    ...(dragOverBacklog
                      ? { border: '1px dashed var(--b3)', background: 'var(--s2)' }
                      : { border: '1px solid var(--b1)', background: 'var(--s1)' }
                    )
                  }}
                >
                  {filteredBacklog.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 0' }}>
                      <p style={{ fontFamily: 'var(--mono)', color: 'var(--b2)', fontSize: 10 }}>
                        {search ? 'No matching tasks' : 'Backlog is empty'}
                      </p>
                    </div>
                  ) : (
                    filteredBacklog.map(task => (
                      <div
                        key={task.id}
                        draggable={isAdminLead && !!activeSprint}
                        onDragStart={e => handleDragFromBacklog(e, task)}
                        style={isAdminLead && activeSprint ? { cursor: 'grab' } : {}}
                      >
                        <TaskRow
                          task={task}
                          actions={isAdminLead && activeSprint ? (
                            <AddButton onClick={() => setPendingAdd({ task, sprint_id: activeSprint.id })} />
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
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 40 }}
              onClick={() => setPendingAdd(null)}
            />
            <div style={{
              position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              background: 'var(--s1)', border: '1px solid var(--b2)', borderRadius: 8,
              padding: 24, zIndex: 50, width: 320
            }}>
              <h3 style={{ fontFamily: 'var(--head)', fontSize: 13, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text)', margin: 0, marginBottom: 4 }}>Add to Sprint</h3>
              <p style={{ fontFamily: 'var(--mono)', color: 'var(--t3)', fontSize: 10, marginBottom: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingAdd.task.title}</p>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>Due Date (optional)</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  min={activeSprint?.start_date}
                  max={activeSprint?.end_date}
                  style={{
                    width: '100%', boxSizing: 'border-box', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6,
                    padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => addToSprint(pendingAdd.task, pendingAdd.sprint_id, dueDate)}
                  style={{
                    flex: 1, background: '#F2CD1A', color: '#080808', fontFamily: 'var(--head)', fontWeight: 700,
                    fontSize: 11, letterSpacing: '.15em', textTransform: 'uppercase',
                    padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer'
                  }}
                >
                  Add to Sprint
                </button>
                <button
                  onClick={() => { setPendingAdd(null); setDueDate(''); }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px' }}
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
