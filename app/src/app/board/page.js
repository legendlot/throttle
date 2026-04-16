'use client';
import { useEffect, useState, useCallback } from 'react';
import Layout from '@/components/Layout';
import TaskSidePanel from '@/components/TaskSidePanel';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import {
  BOARD_STAGES, PRIORITIES,
  getStageConfig, getPriorityConfig, canMoveTask
} from '@/lib/taskConfig';

// ── Kanban Card ───────────────────────────────────────────────────────────────

function TaskCard({ task, onClick, isDragging }) {
  const priority = getPriorityConfig(task.priority);
  const stage = getStageConfig(task.stage);

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('taskId', task.id);
        e.dataTransfer.setData('fromStage', task.stage);
      }}
      onClick={() => onClick(task)}
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--b1)',
        borderLeft: `3px solid ${priority.color}`,
        borderRadius: 6,
        padding: '10px 12px',
        cursor: 'pointer',
        opacity: isDragging ? 0.5 : 1,
        transition: 'border-color .15s',
        userSelect: 'none',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--b3)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--b1)'}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em' }}>
          {task.type}
        </span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {task.is_spillover && <span style={{ fontSize: 10, color: 'var(--amber)' }}>↩</span>}
          {task.stage === 'ext_blocked' && <span style={{ fontSize: 10, color: 'var(--amber)' }}>⚠</span>}
          {task.is_revision && <span style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', background: 'var(--s3)', padding: '1px 5px', borderRadius: 3 }}>REV</span>}
        </div>
      </div>

      <p style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--text)',
        lineHeight: 1.4,
        marginBottom: 8,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {task.title}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {task.product_code && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>
            {task.product_code}
          </span>
        )}
        {task.due_date && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginLeft: 'auto' }}>
            {new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Kanban Column ─────────────────────────────────────────────────────────────

function KanbanColumn({ stage, tasks, onTaskClick, onDrop, canDrop }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const config = getStageConfig(stage);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', minWidth: 208, width: 208, flexShrink: 0 }}
      onDragOver={e => { if (canDrop) { e.preventDefault(); setIsDragOver(true); } }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setIsDragOver(false);
        if (canDrop) {
          const taskId = e.dataTransfer.getData('taskId');
          const fromStage = e.dataTransfer.getData('fromStage');
          onDrop(taskId, fromStage, stage);
        }
      }}
    >
      {/* Column header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
        padding: '6px 4px',
        borderRadius: 6,
        background: isDragOver ? 'var(--s2)' : 'transparent',
        transition: 'background .15s',
      }}>
        <span style={{
          fontFamily: 'var(--head)',
          fontSize: 10,
          letterSpacing: '.25em',
          textTransform: 'uppercase',
          color: config.color || 'var(--t3)',
          fontWeight: 700,
        }}>
          {config.label}
        </span>
        <span style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--t3)',
          background: 'var(--s2)',
          padding: '2px 6px',
          borderRadius: 3,
        }}>
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        flex: 1,
        minHeight: 96,
        borderRadius: 6,
        padding: 4,
        transition: 'all .15s',
        background: isDragOver ? 'rgba(42,42,42,0.3)' : 'transparent',
        border: isDragOver ? '1px dashed var(--b2)' : '1px solid transparent',
      }}>
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onClick={onTaskClick}
          />
        ))}
        {tasks.length === 0 && isDragOver && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>Drop here</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Table View ────────────────────────────────────────────────────────────────

function TableView({ tasks, onTaskClick }) {
  const [sortKey, setSortKey] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');
  const [filterStage, setFilterStage] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const filtered = tasks
    .filter(t => filterStage === 'all' || t.stage === filterStage)
    .filter(t => filterPriority === 'all' || t.priority === filterPriority)
    .sort((a, b) => {
      let av = a[sortKey] || '';
      let bv = b[sortKey] || '';
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  const selectStyle = {
    background: 'var(--s2)',
    border: '1px solid var(--b2)',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 11,
    color: 'var(--t2)',
    fontFamily: 'var(--mono)',
    outline: 'none',
  };

  const thStyle = {
    padding: '8px 12px',
    textAlign: 'left',
    fontFamily: 'var(--head)',
    fontSize: 9,
    letterSpacing: '.2em',
    textTransform: 'uppercase',
    color: 'var(--t3)',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  return (
    <div>
      {/* Table filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <select value={filterStage} onChange={e => setFilterStage(e.target.value)} style={selectStyle}>
          <option value="all">All Stages</option>
          {BOARD_STAGES.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} style={selectStyle}>
          <option value="all">All Priorities</option>
          {PRIORITIES.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          {filtered.length} task{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--b1)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--s1)', borderBottom: '1px solid var(--b1)' }}>
              <th style={thStyle} onClick={() => handleSort('title')}>
                Title {sortKey === 'title' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th style={thStyle} onClick={() => handleSort('stage')}>
                Stage {sortKey === 'stage' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th style={thStyle} onClick={() => handleSort('priority')}>
                Priority {sortKey === 'priority' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th style={{ ...thStyle, cursor: 'default' }}>Product</th>
              <th style={{ ...thStyle, cursor: 'default' }}>Type</th>
              <th style={thStyle} onClick={() => handleSort('due_date')}>
                Due {sortKey === 'due_date' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th style={thStyle} onClick={() => handleSort('created_at')}>
                Created {sortKey === 'created_at' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--t3)', fontSize: 12, padding: '40px 0' }}>
                  No tasks match these filters
                </td>
              </tr>
            ) : (
              filtered.map((task, i) => {
                const stage = getStageConfig(task.stage);
                const priority = getPriorityConfig(task.priority);
                return (
                  <tr
                    key={task.id}
                    onClick={() => onTaskClick(task)}
                    style={{
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--b1)',
                      background: i % 2 !== 0 ? 'var(--s1)' : 'transparent',
                      transition: 'background .1s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--s2)'}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 !== 0 ? 'var(--s1)' : 'transparent'}
                  >
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {task.is_spillover && <span style={{ color: 'var(--amber)', fontSize: 11 }}>↩</span>}
                        <span style={{ color: 'var(--text)', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                          {task.title}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: stage.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--t2)', fontSize: 11 }}>{stage.label}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: priority.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--t2)', fontSize: 11 }}>{priority.label}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--t3)', fontSize: 11 }}>{task.product_code || '—'}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--t3)', fontSize: 11, textTransform: 'capitalize' }}>
                      {task.type?.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--t3)', fontSize: 11 }}>
                      {task.due_date
                        ? new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                        : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--t3)', fontSize: 11 }}>
                      {new Date(task.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Person Filter ────────────────────────────────────────────────────────────

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

// ── Main Board Page ───────────────────────────────────────────────────────────

export default function BoardPage() {
  const { session, brandUser } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('kanban');
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);

  useEffect(() => {
    if (brandUser) loadTasks();
  }, [brandUser]);

  useEffect(() => {
    if (brandUser?.role !== 'requester' && session) {
      workerFetch('getTeamMembers', {}, session?.access_token)
        .then(data => setTeamMembers(data.members || []))
        .catch(() => {});
    }
  }, [brandUser, session]);

  async function loadTasks() {
    setLoading(true);
    const { data, error } = await supabase
      .from('tasks')
      .select('*, task_assignees(user_id)')
      .not('stage', 'in', '("done","abandoned")')
      .order('created_at', { ascending: false });
    if (!error) setTasks(data || []);
    setLoading(false);
  }

  async function handleDrop(taskId, fromStage, toStage) {
    if (fromStage === toStage) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    if (!canMoveTask(task, toStage, brandUser?.role)) return;

    if (toStage === 'ext_blocked' || toStage === 'abandoned') {
      setSelectedTask({ ...task, _pendingStage: toStage });
      return;
    }

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, stage: toStage } : t));
    try {
      await workerFetch('updateTaskStage', { task_id: taskId, stage: toStage }, session?.access_token);
    } catch {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, stage: fromStage } : t));
    }
  }

  function handleTaskUpdate(updatedTask) {
    setTasks(prev => prev.map(t => t.id === updatedTask.id ? updatedTask : t));
    setSelectedTask(updatedTask);
  }

  const visibleTasks = selectedPerson
    ? tasks.filter(t => t.task_assignees?.some(a => a.user_id === selectedPerson))
    : tasks;

  const tasksByStage = BOARD_STAGES.reduce((acc, stage) => {
    acc[stage.value] = visibleTasks.filter(t => t.stage === stage.value);
    return acc;
  }, {});

  const reviewCount = tasksByStage['in_review']?.length || 0;

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Board header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)', lineHeight: 1 }}>
              Board
            </h1>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
              {selectedPerson ? `${visibleTasks.length} of ${tasks.length}` : tasks.length} active task{(selectedPerson ? visibleTasks.length : tasks.length) !== 1 ? 's' : ''}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Review queue indicator */}
            {isAdminLead && reviewCount > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.3)',
                borderRadius: 6, padding: '6px 12px',
              }}>
                <span style={{ fontSize: 11, color: '#22d3ee' }}>👀</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#22d3ee', fontWeight: 500 }}>
                  {reviewCount} awaiting review
                </span>
              </div>
            )}

            {/* Person filter */}
            {brandUser?.role !== 'requester' && teamMembers.length > 0 && (
              <PersonFilter members={teamMembers} selected={selectedPerson} onChange={setSelectedPerson} />
            )}

            {/* View toggle */}
            <div style={{ display: 'flex', background: 'var(--s1)', border: '1px solid var(--b1)', borderRadius: 6, padding: 2 }}>
              {[
                { value: 'kanban', label: 'Kanban' },
                { value: 'table', label: 'Table' },
              ].map(v => (
                <button
                  key={v.value}
                  onClick={() => setView(v.value)}
                  style={{
                    padding: '6px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    fontWeight: view === v.value ? 700 : 400,
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    transition: 'all .15s',
                    background: view === v.value ? 'var(--s3)' : 'transparent',
                    color: view === v.value ? 'var(--text)' : 'var(--t3)',
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
            <p style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>Loading tasks...</p>
          </div>
        ) : view === 'kanban' ? (
          <div style={{ overflowX: 'auto', paddingBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, minWidth: 'max-content' }}>
              {BOARD_STAGES.map(stage => (
                <KanbanColumn
                  key={stage.value}
                  stage={stage.value}
                  tasks={tasksByStage[stage.value] || []}
                  onTaskClick={setSelectedTask}
                  onDrop={handleDrop}
                  canDrop={true}
                />
              ))}
            </div>
          </div>
        ) : (
          <TableView tasks={visibleTasks} onTaskClick={setSelectedTask} />
        )}

        {selectedTask && (
          <TaskSidePanel
            task={selectedTask}
            onClose={() => setSelectedTask(null)}
            onUpdate={handleTaskUpdate}
          />
        )}
      </div>
    </Layout>
  );
}
