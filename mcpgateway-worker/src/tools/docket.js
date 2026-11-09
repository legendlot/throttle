// Docket tools: READ and MANAGE a person's tasks. Every call reaches docketops AS THE PERSON (their own
// Supabase JWT, service binding DOCKETOPS), so Docket's own rules decide what they may see and edit
// (owner / creator / collaborator / own department; docket_admin + docket_view_all widen it).
// Write safety (Afshaan 2026-11-09 asked for read + write so Claude can manage a task list):
//   - only single-task actions; no bulk actions, no space/role/program/template admin, no deletes
//     (Docket has no task delete; abandon is reversible via set_status and needs a reason);
//   - every write is a separate tool with readOnlyHint:false, so Claude asks before each one unless
//     the person has chosen otherwise in their own Claude settings;
//   - every write is audited before it runs (the gateway's call row), and Docket logs task_history.
//   - docketops sends no Slack/email on any action (decisions: docketops has no webhook/cron).
import { T, reportTool } from './build.js';
import { getAs, postAs, scrub, capPayload } from '../workers.js';

// LOT user ids carried by task rows; the names ride alongside (creator_name, author_name, actor_name).
const DOCKET_DROP = ['auth_user_id', 'created_by_user_id', 'updated_by', 'abandoned_by', 'author_user_id', 'actor_user_id', 'added_by'];

// The Docket app makes an abandoned task read-only (TaskView `canEdit = _can_edit && status !== 'abandoned'`,
// decisions 2026-11-09), but docketops' single-task endpoints don't enforce it, so the gateway does: these
// tools read the task first. Also refuses a deadline edit docketops would silently ignore.
async function guardTask(env, sbAccess, input, rule) {
  const r = await getAs(env.DOCKETOPS, sbAccess, 'getTask', { id: input.id });
  if (!r.ok) return r.reason === 'worker denied' ? { ok: false, reason: 'docket denied' } : r;
  const e = rule(r.data || {});
  return e ? { ok: false, userError: e } : null;
}
const notAbandoned = t => (t.status === 'abandoned' ? 'this task is abandoned, so it is read-only (as in the Docket app). Reopen it first with docket_set_status.' : null);

const TASK = { ...T.uuid, about: 'The task id (from a task list).' };
const STATUS = T.oneOf('not_started', 'in_progress', 'done', 'blocked');
const PRIORITY = T.oneOf('P0', 'P1', 'P2', 'P3');
const longText = max => ({ schema: { type: 'string', maxLength: max }, check: v => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? { ok: true, value: v.trim() } : { ok: false, error: `must be non-empty text up to ${max} characters` } });
const optText = max => ({ allowEmpty: true, schema: { type: 'string', maxLength: max }, check: v => typeof v === 'string' && v.length <= max ? { ok: true, value: v } : { ok: false, error: `must be text up to ${max} characters` } });

// A single-action write tool. params: { name: { ...type, about } }; required: names.
function writeTool({ name, title, description, action, params, required = [], destructive = false, finalize, check, guard }) {
  const props = {};
  for (const [k, p] of Object.entries(params)) props[k] = { ...p.schema, description: p.about || '' };
  return {
    system: 'docket',
    name, title,
    description: `${description} Changes Docket data as you; recorded in the task's history.`,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false },
    needsSession: true,
    write: true,
    action,
    parse: args => {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(params, k)) return { ok: false, error: `\`${k}\` is not a field of ${name} (it takes: ${Object.keys(params).join(', ')})` };
      const data = {};
      for (const [k, p] of Object.entries(params)) {
        const v = a[k];
        // '' clears an optional text field (description, note) and is otherwise "not given" (Codex 2026-11-09).
        if (v === undefined || v === null || (v === '' && !p.allowEmpty)) { if (required.includes(k)) return { ok: false, error: `\`${k}\` is required` }; continue; }
        const c = p.check(v);
        if (!c.ok) return { ok: false, error: `\`${k}\` ${c.error}` };
        data[p.as || k] = p.raw ? v : c.value;
      }
      if (check) { const e = check(data); if (e) return { ok: false, error: e }; }
      return { ok: true, value: finalize ? finalize(data) : data };
    },
    run: async ({ env, sbAccess, input }) => {
      if (guard) { const g = await guardTask(env, sbAccess, input, t => guard(t, input)); if (g) return g; }
      const res = await postAs(env.DOCKETOPS, sbAccess, action, input);
      if (!res.ok) {
        if (res.reason === 'worker denied') return { ok: false, reason: 'docket denied' };
        // docketops' `*_failed: {db}`: most often an id that does not exist (FK). Plain words, no DB text.
        if (res.serverFail) return { ok: false, userError: 'Docket could not save that change. Check that any ids given (owner, program, space) came from docket_tasks, and check the task before trying again.' };
        if (res.reason === 'unreachable') return { ok: false, reason: 'write unconfirmed' };
        return res;
      }
      // Always an object (structuredContent must be one), scrubbed like every read.
      return { ok: true, data: { done: name, result: capPayload(scrub(res.data)).data } };
    },
  };
}

const docketTools = [
  reportTool({
    system: 'docket', name: 'docket_tasks', title: 'Docket tasks', binding: 'DOCKETOPS', dropKeys: DOCKET_DROP,
    description: 'Read Docket: your own task list (tasks you own, created or collaborate on), a space\'s tasks, one task in full (comments, history, collaborators, subtasks), and the spaces/programs you can see. Docket\'s own visibility rules apply.',
    paramAbout: { status: 'Filter by status.', priority: 'Filter by priority.', overdue: 'Only overdue tasks.', q: 'Search text in titles.', program_id: 'Limit to one program.', space_id: 'The space (from report=spaces). Omit for the default space.', id: 'Task id.' },
    reports: {
      my_tasks: { action: 'getMyTasks', about: 'your own tasks (owner, creator or collaborator), filterable', params: { status: T.oneOf('not_started', 'in_progress', 'done', 'blocked', 'abandoned'), priority: PRIORITY, overdue: T.bool, q: T.text, program_id: T.uuid } },
      space_tasks: { action: 'getTasks', about: 'tasks in one space you can access, filterable', params: { space_id: T.uuid, status: T.oneOf('not_started', 'in_progress', 'done', 'blocked', 'abandoned'), priority: PRIORITY, overdue: T.bool, q: T.text, program_id: T.uuid } },
      task: { action: 'getTask', about: 'one task in full: comments, history, collaborators, documents, subtasks', params: { id: T.uuid }, required: ['id'] },
      program_tasks: { action: 'getProgramTasks', about: 'tasks across spaces for one program', params: { program_id: T.uuid }, required: ['program_id'] },
      spaces: { action: 'getSpaces', about: 'the spaces you can see, with ids', params: {} },
      programs: { action: 'getPrograms', about: 'programs, with ids', params: {} },
      // Names + departments only (Docket's getEmployees is ungated and also carries auth ids): for assigning owners.
      people: { action: 'getEmployees', about: 'people you can assign tasks to (id, name, department)', params: {}, shape: d => ({ people: (Array.isArray(d) ? d : (d && (d.rows || d.employees)) || []).map(e => ({ id: e.id, name: e.full_name, department_id: e.department_id || null })) }) },
    },
  }),
  writeTool({
    name: 'docket_create_task', title: 'Create a Docket task', action: 'createTask',
    description: 'Create a task. Only a title is required; by default it is put on your own list (assign_self). Give owner_employee_id (from docket_tasks report=people) to assign it to someone else.',
    params: {
      title: { ...longText(200), about: 'Task title.' },
      description: { ...optText(4000), about: 'Details.' },
      priority: { ...PRIORITY, about: 'P0 (urgent) to P3. Default P2.' },
      deadline: { ...T.date, about: 'Due date, YYYY-MM-DD.' },
      owner_employee_id: { ...T.uuid, about: 'Owner (employee id). Omit to own it yourself.' },
      space_id: { ...T.uuid, about: 'Space id. Omit for the default space.' },
      program_id: { ...T.uuid, about: 'Program id.' },
    },
    required: ['title'],
    finalize: d => (d.owner_employee_id ? d : { ...d, assign_self: true }),
  }),
  writeTool({
    name: 'docket_update_task', title: 'Edit a Docket task', action: 'updateTask',
    description: 'Change a task\'s title, description, priority, owner or program, or set a FIRST deadline on a task that has none (to move an existing deadline use docket_revise_deadline). Status changes use docket_set_status.',
    params: {
      id: TASK,
      title: { ...longText(200), about: 'New title.' },
      description: { ...optText(4000), about: 'New description.' },
      priority: { ...PRIORITY, about: 'New priority.' },
      owner_employee_id: { ...T.uuid, about: 'New owner (employee id).' },
      program_id: { ...T.uuid, about: 'New program id.' },
      deadline: { ...T.date, about: 'First deadline, only if the task has none yet.' },
    },
    required: ['id'],
    check: d => (Object.keys(d).length > 1 ? null : 'give at least one field to change besides `id`'),
    guard: (t, d) => notAbandoned(t) || (d.deadline && t.deadline ? 'this task already has a deadline; move it with docket_revise_deadline (a reason is required).' : null),
  }),
  writeTool({
    name: 'docket_set_status', title: 'Set a Docket task\'s status', action: 'changeStatus',
    description: 'Move a task to not_started, in_progress, done or blocked (this also reopens an abandoned task).',
    params: { id: TASK, status: { ...STATUS, about: 'New status.' }, note: { ...optText(500), about: 'Optional note for the history.' } },
    required: ['id', 'status'],
  }),
  writeTool({
    name: 'docket_revise_deadline', title: 'Revise a Docket deadline', action: 'reviseDeadline',
    description: 'Move a task\'s deadline. A reason is required; the original deadline is kept.',
    params: { id: TASK, new_deadline: { ...T.date, about: 'New due date, YYYY-MM-DD.' }, reason: { ...longText(500), about: 'Why it moved.' } },
    required: ['id', 'new_deadline', 'reason'],
    guard: notAbandoned,
  }),
  writeTool({
    name: 'docket_add_comment', title: 'Comment on a Docket task', action: 'addComment',
    description: 'Add a comment to a task you can see.',
    params: { id: TASK, body: { ...longText(4000), about: 'The comment.' } },
    required: ['id', 'body'],
    // getTask applies the private-space gate that docketops' addComment skips (hostile review 2026-11-09).
    guard: () => null,
  }),
  writeTool({
    name: 'docket_abandon_task', title: 'Abandon a Docket task', action: 'abandonTask',
    description: 'Mark a task abandoned (it is never deleted; docket_set_status reopens it). A reason is required.',
    params: { id: TASK, reason: { ...longText(500), about: 'Why it is abandoned.' } },
    required: ['id', 'reason'],
    destructive: true,
    guard: t => (t.status === 'abandoned' ? 'this task is already abandoned.' : null),
  }),
];
export default docketTools;
