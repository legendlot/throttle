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
      className={`bg-zinc-900 border rounded-lg p-3 cursor-pointer hover:border-zinc-600 transition-all select-none ${
        isDragging ? 'opacity-50 border-zinc-500' : 'border-zinc-800'
      }`}
    >
      {/* Priority indicator */}
      <div className="flex items-center justify-between mb-2">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: priority.color }}
        />
        {task.is_spillover && (
          <span className="text-xs text-amber-500">↩</span>
        )}
        {task.stage === 'ext_blocked' && (
          <span className="text-xs text-amber-400">⚠</span>
        )}
      </div>

      {/* Title */}
      <p className="text-zinc-200 text-xs font-medium leading-snug mb-2 line-clamp-2">
        {task.title}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between mt-1">
        {task.product_code && (
          <span className="text-zinc-700 text-xs truncate max-w-20">{task.product_code}</span>
        )}
        {task.due_date && (
          <span className="text-zinc-700 text-xs ml-auto">
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
      className="flex flex-col min-w-52 w-52 flex-shrink-0"
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
      <div className={`flex items-center justify-between mb-3 px-1 py-1.5 rounded-lg transition-colors ${
        isDragOver ? 'bg-zinc-800' : ''
      }`}>
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: config.color }}
          />
          <span className="text-xs font-medium text-zinc-400">{config.label}</span>
        </div>
        <span className="text-xs text-zinc-700 bg-zinc-800 px-1.5 py-0.5 rounded">
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className={`flex flex-col gap-2 flex-1 min-h-24 rounded-lg p-1 transition-colors ${
        isDragOver ? 'bg-zinc-800/50 border border-dashed border-zinc-600' : ''
      }`}>
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onClick={onTaskClick}
          />
        ))}
        {tasks.length === 0 && isDragOver && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-zinc-700 text-xs">Drop here</p>
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

  function SortHeader({ label, field }) {
    return (
      <th
        className="text-left text-xs text-zinc-500 font-medium px-3 py-2 cursor-pointer hover:text-zinc-300 transition-colors whitespace-nowrap"
        onClick={() => handleSort(field)}
      >
        {label}
        {sortKey === field && (
          <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </th>
    );
  }

  return (
    <div>
      {/* Table filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filterStage}
          onChange={e => setFilterStage(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none"
        >
          <option value="all">All Stages</option>
          {BOARD_STAGES.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={filterPriority}
          onChange={e => setFilterPriority(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none"
        >
          <option value="all">All Priorities</option>
          {PRIORITIES.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <span className="text-zinc-700 text-xs self-center ml-auto">
          {filtered.length} task{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full">
          <thead className="bg-zinc-900">
            <tr>
              <SortHeader label="Title" field="title" />
              <SortHeader label="Stage" field="stage" />
              <SortHeader label="Priority" field="priority" />
              <th className="text-left text-xs text-zinc-500 font-medium px-3 py-2">Product</th>
              <th className="text-left text-xs text-zinc-500 font-medium px-3 py-2">Type</th>
              <SortHeader label="Due" field="due_date" />
              <SortHeader label="Created" field="created_at" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-zinc-600 text-sm py-10">
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
                    className={`cursor-pointer hover:bg-zinc-800/50 transition-colors border-t border-zinc-800 ${
                      i % 2 === 0 ? '' : 'bg-zinc-900/30'
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {task.is_spillover && <span className="text-amber-500 text-xs">↩</span>}
                        <span className="text-zinc-200 text-xs font-medium truncate max-w-48">
                          {task.title}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: stage.color }}
                        />
                        <span className="text-zinc-400 text-xs">{stage.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: priority.color }}
                        />
                        <span className="text-zinc-400 text-xs">{priority.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 text-xs">{task.product_code || '—'}</td>
                    <td className="px-3 py-2.5 text-zinc-600 text-xs capitalize">
                      {task.type?.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 text-xs">
                      {task.due_date
                        ? new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-700 text-xs">
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

// ── Main Board Page ───────────────────────────────────────────────────────────

export default function BoardPage() {
  const { session, brandUser } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('kanban'); // 'kanban' | 'table'
  const [selectedTask, setSelectedTask] = useState(null);
  const [dragTaskId, setDragTaskId] = useState(null);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);

  useEffect(() => {
    if (brandUser) loadTasks();
  }, [brandUser]);

  async function loadTasks() {
    setLoading(true);
    let query = supabase
      .from('tasks')
      .select('*')
      .not('stage', 'in', '("done","abandoned")')
      .order('created_at', { ascending: false });

    // Members only see their own tasks — RLS handles this
    // but we also filter client side for clarity
    if (brandUser?.role === 'member') {
      // RLS will enforce this — no need for additional filter
    }

    const { data, error } = await query;
    if (!error) setTasks(data || []);
    setLoading(false);
  }

  async function handleDrop(taskId, fromStage, toStage) {
    if (fromStage === toStage) return;

    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    if (!canMoveTask(task, toStage, brandUser?.role)) return;

    // Require reason for ext_blocked — can't do inline on drop, open panel instead
    if (toStage === 'ext_blocked' || toStage === 'abandoned') {
      setSelectedTask({ ...task, _pendingStage: toStage });
      return;
    }

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, stage: toStage } : t));

    try {
      await workerFetch('updateTaskStage', {
        task_id: taskId,
        stage: toStage,
      }, session?.access_token);
    } catch {
      // Revert on failure
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, stage: fromStage } : t));
    }
  }

  function handleTaskUpdate(updatedTask) {
    setTasks(prev => prev.map(t => t.id === updatedTask.id ? updatedTask : t));
    setSelectedTask(updatedTask);
  }

  // Group tasks by stage for kanban
  const tasksByStage = BOARD_STAGES.reduce((acc, stage) => {
    acc[stage.value] = tasks.filter(t => t.stage === stage.value);
    return acc;
  }, {});

  return (
    <Layout>
      <div className="flex flex-col h-full">
        {/* Board header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold text-white">Board</h1>
            <p className="text-zinc-600 text-xs mt-0.5">
              {tasks.length} active task{tasks.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              {[
                { value: 'kanban', label: 'Kanban' },
                { value: 'table', label: 'Table' },
              ].map(v => (
                <button
                  key={v.value}
                  onClick={() => setView(v.value)}
                  className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    view === v.value
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-zinc-600 text-sm">Loading tasks...</p>
          </div>
        ) : view === 'kanban' ? (
          /* Kanban view — horizontally scrollable */
          <div className="overflow-x-auto pb-4">
            <div className="flex gap-3 min-w-max">
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
          /* Table view */
          <TableView tasks={tasks} onTaskClick={setSelectedTask} />
        )}

        {/* Side panel */}
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
