// Docket tools: READ and MANAGE a person's tasks. Every call reaches docketops AS THE PERSON (their own
// Supabase JWT, service binding DOCKETOPS), so Docket's own rules decide what they may see and edit
// (owner / creator / collaborator / own department; docket_admin + docket_view_all widen it).
// Write safety (Afshaan 2026-11-09 asked for read + write so Claude can manage a task list):
//   - only single-task actions (and applying a plan template, F9 R9a); no bulk actions, no space/role/
//     template admin (templates are edited in the app only), no deletes. Programs are retired (F9 R9b,
//     RULE-DOCKET-004 superseded): no program filter or field; a task row still carries its program read-only
//     (Docket has no task delete; abandon is reversible via set_status and needs a reason);
//   - every write is a separate tool with readOnlyHint:false, so Claude asks before each one unless
//     the person has chosen otherwise in their own Claude settings;
//   - every write is audited before it runs (the gateway's call row), and Docket logs task_history.
//   - docketops sends no Slack/email on any action (decisions: docketops has no webhook/cron).
import { T, reportTool } from './build.js';
import { getAs, postAs, scrub, capPayload } from '../workers.js';

// LOT user ids carried by task rows; the names ride alongside (creator_name, author_name, actor_name).
const DOCKET_DROP = ['auth_user_id', 'created_by_user_id', 'updated_by', 'abandoned_by', 'author_user_id', 'actor_user_id', 'added_by',
  'proposer_user_id', 'decided_by',    // F9 R3 proposals (docketops already strips them; belt and braces)
  'founder_user_id',                    // F9 R6b founders' top 5 (is_me + founder_name ride alongside)
  'handoff_accepted_by',                // F9 R8 hand-offs (handoff_accepted_by_name rides alongside)
  'created_by'];                        // F9 R9a templates (created_by_name rides alongside)

// The Docket app makes an abandoned task read-only (TaskView `canEdit = _can_edit && status !== 'abandoned'`,
// decisions 2026-11-09), but docketops' single-task endpoints don't enforce it, so the gateway does: these
// tools read the task first. Also refuses a deadline edit docketops would silently ignore.
async function guardTask(env, sbAccess, input, rule) {
  const r = await getAs(env.DOCKETOPS, sbAccess, 'getTask', { id: input.id });
  if (!r.ok) return r.reason === 'worker denied' ? { ok: false, reason: 'docket denied' } : r;
  const e = rule(r.data || {});
  return e ? { ok: false, userError: e, byGateway: true } : null;
}
const notAbandoned = t => (t.status === 'abandoned' ? 'this task is abandoned, so it is read-only (as in the Docket app). Reopen it first with docket_set_status.' : null);

const TASK = { ...T.uuid, about: 'The task id (from a task list).' };
const STATUS = T.oneOf('not_started', 'in_progress', 'done', 'blocked');
const PRIORITY = T.oneOf('P0', 'P1', 'P2', 'P3');
// F9 R4: the Week filter docketops applies to its task lists (IST, the org's week end): this / next /
// overdue / none (no date), or any YYYY-MM-DD → the week holding that date.
const WEEK = { schema: { type: 'string', maxLength: 10 }, check: v => (['this', 'next', 'overdue', 'none'].includes(v) || T.date.check(v).ok)
  ? { ok: true, value: v } : { ok: false, error: 'must be this, next, overdue, none, or a date YYYY-MM-DD (its week)' } };
// F9 R5: which week's on-time score — this (provisional), last (final once it closed), or the week holding a date.
const SCORE_WEEK = { schema: { type: 'string', maxLength: 10 }, check: v => (['this', 'last'].includes(v) || T.date.check(v).ok)
  ? { ok: true, value: v } : { ok: false, error: 'must be this, last, or a date YYYY-MM-DD (its week)' } };
// F9 R6a: one team (a department id from docket_tasks report=people) or all of them.
const TEAM = { schema: { type: 'string', maxLength: 36 }, check: v => (v === 'all' || T.uuid.check(v).ok)
  ? { ok: true, value: v } : { ok: false, error: 'must be all or a department id (uuid)' } };
// F9 R9b: a month for the re-plan (YYYY-MM).
const MONTHV = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH = { schema: { type: 'string', pattern: MONTHV.source }, check: v => (typeof v === 'string' && MONTHV.test(v))
  ? { ok: true, value: v } : { ok: false, error: 'must be a month, YYYY-MM' } };
// F9 R6b: which week a founder's top 5 is for — this, next, or the week holding a date.
const FOCUS_WEEK = { schema: { type: 'string', maxLength: 10 }, check: v => (['this', 'next'].includes(v) || T.date.check(v).ok)
  ? { ok: true, value: v } : { ok: false, error: 'must be this, next, or a date YYYY-MM-DD (its week)' } };
// The top 5 itself: shaped here, decided by Docket (ranks, visibility, the closed-week rule — setFounderFocus).
const UUIDV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOCUS_ITEMS = {
  schema: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['rank'], properties: {
    rank: { type: 'integer', minimum: 1, maximum: 5 }, plan_item_id: { type: 'string' }, task_id: { type: 'string' },
    note: { type: 'string', maxLength: 500 } } } },
  check: (v) => {
    if (!Array.isArray(v) || v.length > 5) return { ok: false, error: 'must be a list of at most 5 items' };
    const out = [];
    for (const it of v) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, error: 'each item must be { rank, plan_item_id | task_id | note }' };
      const extra = Object.keys(it).find(k => !['rank', 'plan_item_id', 'task_id', 'note'].includes(k));
      if (extra) return { ok: false, error: `item field \`${extra}\` is not allowed (rank, plan_item_id, task_id, note)` };
      if (!Number.isInteger(it.rank) || it.rank < 1 || it.rank > 5) return { ok: false, error: 'each item needs a rank 1–5' };
      for (const k of ['plan_item_id', 'task_id']) if (it[k] != null && it[k] !== '' && !(typeof it[k] === 'string' && UUIDV.test(it[k]))) return { ok: false, error: `\`${k}\` must be an id (uuid)` };
      if (it.note != null && (typeof it.note !== 'string' || it.note.length > 500)) return { ok: false, error: 'a note is text up to 500 characters' };
      const o = { rank: it.rank };
      for (const k of ['plan_item_id', 'task_id', 'note']) if (it[k] != null && it[k] !== '') o[k] = it[k];
      out.push(o);
    }
    return { ok: true, value: out };
  },
};
// F9 R2: a task's plan link. Docket decides who may set it (edit right on the task + the item visible to you
// as its owner, a theme, or a super admin; live items only) — the gateway only shapes it.
const PLAN_ITEM = { ...T.uuid, nullable: true, schema: { type: ['string', 'null'] } };
// F9 R8: a hand-off's receiving side — a department and/or a named receiver (ids from docket_tasks report=people);
// null clears. Docket validates (receiver in that department, not the task's own team, top-level only) and
// never lets these set the acceptance — only docket_accept_handoff does.
const HANDOFF_ID = { ...T.uuid, nullable: true, schema: { type: ['string', 'null'] } };
// F9 R9a: a template's roles → people: { "<role label>": "<employee id from docket_tasks report=people>" }. Docket
// checks every role is mapped to an active person and that no label is foreign to the template.
const TEMPLATE_ROLES = {
  schema: { type: 'object', maxProperties: 200, additionalProperties: { type: 'string' } },
  raw: true,
  check: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'must be an object { "<role label>": "<employee id>" }' };
    const keys = Object.keys(v);
    if (!keys.length || keys.length > 200) return { ok: false, error: 'must map 1–200 roles' };
    for (const k of keys) {
      if (!k.trim() || k.length > 40) return { ok: false, error: 'each role label is 1–40 characters' };
      if (typeof v[k] !== 'string' || !UUIDV.test(v[k])) return { ok: false, error: `role \`${k}\` must map to an employee id (uuid)` };
    }
    return { ok: true, value: v };
  },
};
const longText = max => ({ schema: { type: 'string', maxLength: max }, check: v => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? { ok: true, value: v.trim() } : { ok: false, error: `must be non-empty text up to ${max} characters` } });
const optText = max => ({ allowEmpty: true, schema: { type: 'string', maxLength: max }, check: v => typeof v === 'string' && v.length <= max ? { ok: true, value: v } : { ok: false, error: `must be text up to ${max} characters` } });

// A single-action write tool. params: { name: { ...type, about } }; required: names.
function writeTool({ name, title, description, action, params, required = [], destructive = false, finalize, check, guard, recorded = 'recorded in the task\'s history.' }) {
  const props = {};
  for (const [k, p] of Object.entries(params)) props[k] = { ...p.schema, description: p.about || '' };
  return {
    system: 'docket',
    name, title,
    description: `${description} Changes Docket data as you; ${recorded}`,
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
        // `nullable` (plan_item_id): an explicit null is sent as null — it CLEARS the field.
        if (v === null && p.nullable) { data[p.as || k] = null; continue; }
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
        if (res.serverFail) return { ok: false, userError: 'Docket could not save that change. Check that any ids given (owner, space) came from docket_tasks, and check the task before trying again.' };
        if (res.reason === 'unreachable') return { ok: false, reason: 'write unconfirmed' };
        return res;
      }
      // Always an object (structuredContent must be one), scrubbed like every read.
      return { ok: true, data: { done: name, result: capPayload(scrub(res.data, { dropKeys: DOCKET_DROP })).data } };
    },
  };
}

const docketTools = [
  reportTool({
    system: 'docket', name: 'docket_tasks', title: 'Docket tasks', binding: 'DOCKETOPS', dropKeys: DOCKET_DROP,
    description: 'Read Docket: your own task list (tasks you own, created or collaborate on), a space\'s tasks, one task in full (comments, history, collaborators, subtasks), and the spaces you can see. Docket\'s own visibility rules apply.',
    paramAbout: { status: 'Filter by status.', priority: 'Filter by priority.', overdue: 'Only overdue tasks.', week: 'Only tasks due in one week (IST, Docket\'s week end): this, next, overdue, none (no deadline), or any date YYYY-MM-DD for the week holding it.', q: 'Search text in titles.', space_id: 'The space (from report=spaces). Omit for the default space.', id: 'Task id.' },
    reports: {
      my_tasks: { action: 'getMyTasks', about: 'your own tasks (owner, creator or collaborator), filterable', params: { status: T.oneOf('not_started', 'in_progress', 'done', 'blocked', 'abandoned'), priority: PRIORITY, overdue: T.bool, week: WEEK, q: T.text } },
      space_tasks: { action: 'getTasks', about: 'tasks in one space you can access, filterable', params: { space_id: T.uuid, status: T.oneOf('not_started', 'in_progress', 'done', 'blocked', 'abandoned'), priority: PRIORITY, overdue: T.bool, week: WEEK, q: T.text } },
      task: { action: 'getTask', about: 'one task in full: comments, history, collaborators, documents, subtasks', params: { id: T.uuid }, required: ['id'] },
      spaces: { action: 'getSpaces', about: 'the spaces you can see, with ids', params: {} },
      // Names + departments only (Docket's getEmployees is ungated and also carries auth ids): for assigning owners.
      // F9 R8: hand-offs coming TO you (named) or your team — not-accepted first, then by date.
      incoming: { action: 'getIncoming', about: 'open hand-offs to you (named receiver) or your team, with who gives them; not accepted first', params: { scope: T.oneOf('me', 'team', 'all') } },
      people: { action: 'getEmployees', about: 'people you can assign tasks to (id, name, department)', params: {}, shape: d => ({ people: (Array.isArray(d) ? d : (d && (d.rows || d.employees)) || []).map(e => ({ id: e.id, name: e.full_name, department_id: e.department_id || null })) }) },
    },
  }),
  // F9 R2 — the plan, read through Docket's own projection: a super admin sees everything; everyone else
  // their own milestones + the results under them, and every open theme (code + title). Nothing restricted.
  reportTool({
    system: 'docket', name: 'docket_plan', title: 'Docket plan', binding: 'DOCKETOPS', dropKeys: DOCKET_DROP,
    description: 'Read the Docket plan (themes → milestones → results) at your own level: themes you can link tasks to, the milestones and results you own, one item with its children and the linked tasks you can see. Use the ids as plan_item_id on docket_create_task / docket_update_task (a Founders\' Associate sees every unrestricted item but links only to themes and to items they own).',
    paramAbout: { id: 'For report=item: a plan item id (from report=items or themes). For report=template: a template id (from report=templates).', week: 'For report=score / review / founders: this (default), last (the week just closed), or any date YYYY-MM-DD for the week holding it.',
      team: 'For report=review / trend: a department id, or all. Default: a founder or Founders\' Associate all teams; everyone else their own team.',
      weeks: 'For report=trend: how many closed weeks, 1–26 (default 8).', month: 'For report=replan: YYYY-MM (default next month, IST).' },
    reports: {
      themes: { action: 'getPlan', about: 'the themes you can see (code, title, state)', params: {},
        shape: d => ({ themes: ((d && d.items) || []).filter(x => x.kind === 'theme') }) },
      items: { action: 'getPlan', about: 'every plan item you can see: themes, your milestones and the results under them', params: {},
        shape: d => ({ items: (d && d.items) || [] }) },
      item: { action: 'getPlanItem', about: 'one item: its fields, children, history and the linked tasks you can see', params: { id: T.uuid }, required: ['id'] },
      // F9 R3: a super admin gets the founders' queue (waiting first, then the last 30 days' decisions);
      // everyone else only their own proposals and the outcome — Docket decides which (plan_proposals_for).
      proposals: { action: 'getProposals', about: 'proposals: your own and their outcome (a super admin: the whole Proposed queue)', params: {},
        shape: d => ({ proposals: (d && d.proposals) || [] }) },
      // F9 R5 (spec §8.2): the frozen weekly cohort scored — final once the week closed (Monday 00:00 IST),
      // provisional before. Super admins only (Docket refuses anyone else).
      score: { action: 'getWeekScore', about: 'super admins and Founders\' Associates: the weekly on-time score — per team, per person and per task; provisional (on time / missed so far / still due) until the week closes, then final', params: { week: SCORE_WEEK } },
      // F9 R6a (spec §8.1): the Friday review pack at the caller's level — Docket decides the teams and rows.
      review: { action: 'getReviewPack', about: 'the weekly review pack per team: this week (provisional) and last week (final) on-time score + trend, slipped tasks with every revision, milestones due / re-dated / warnings, staleness, the next two weeks, unplanned share, and a Copy-for-Slack text', params: { week: SCORE_WEEK, team: TEAM } },
      // F9 R6b (spec §8.6): the Saturday founders' catch-up — super admins only (Docket refuses anyone else).
      founders: { action: 'getFoundersReview', about: 'super admins: the Saturday catch-up — cross-team asks (a task waiting on another team\'s task) due this week or next, and each founder\'s top 5', params: { week: SCORE_WEEK } },
      // F9 R9a (spec §11): plan templates — founders' ones to super admins, leads' ones to super admins and leads.
      templates: { action: 'getTemplates', about: 'the plan templates you can use: name, who it is for (founders → applied to a theme, leads → to a milestone), its roles, steps and day span', params: {} },
      template: { action: 'getTemplate', about: 'one template: its steps (titles only unless you can edit it), its roles and day span — what docket_apply_template needs', params: { id: T.uuid }, required: ['id'] },
      // F9 R9b (spec §4.4 P2): an item's measure carries its latest daily auto-check reading (measure.reading) at
      // the levels that see the measure. These three are Docket-gated the same way as the app.
      reached: { action: 'getReachedTargets', about: 'super admins: agreed milestones / results whose daily measure check reached the target — the queue to confirm done (mark done with the reading as evidence)', params: {} },
      trend: { action: 'getScoreTrend', about: 'the weekly on-time % per team over the last closed weeks (a lead: their own team only)', params: { weeks: T.int(1, 26), team: TEAM } },
      replan: { action: 'getReplan', about: 'super admins: the monthly re-plan — the month\'s milestones with readiness (agreed, active owner, data source, actionable tasks in its first two weeks), the risk proposals, and the previous month\'s final weekly scores', params: { month: MONTH } },
    },
  }),
  // F9 R3 — anyone can propose something for the plan (spec §4.5). It lands in the founders' queue; nothing
  // is created on the plan until a founder accepts it.
  writeTool({
    name: 'docket_propose', title: 'Propose a Docket plan item', action: 'proposePlanItem',
    description: 'Propose something that should be on the Docket plan and is not: a milestone to deliver, or a risk. It goes to the founders\' Proposed queue; you see whether it was accepted or declined (with their reason) via docket_plan report=proposals. Optionally suggest a theme (an id from docket_plan report=themes) and a date.',
    recorded: 'it is a proposal, so nothing on the plan changes until a founder accepts it.',
    params: {
      title: { ...longText(200), about: 'What should be on the plan.' },
      why: { ...longText(2000), about: 'Why it matters (the founders read this when deciding).' },
      kind_hint: { ...T.oneOf('milestone', 'risk'), about: 'milestone (something to deliver, the default) or risk (something that could go wrong).' },
      suggested_theme_id: { ...T.uuid, about: 'Optional: the theme it belongs under (from docket_plan report=themes).' },
      suggested_date: { ...T.date, about: 'Optional: by when, YYYY-MM-DD.' },
    },
    required: ['title', 'why'],
  }),
  // F9 R6b — a founder's top 5 for a week (spec §8.6). One call replaces the caller's whole list for that
  // week (Docket does it in one transaction); items: [] clears it. Super admins only (Docket refuses others).
  writeTool({
    name: 'docket_founder_focus', title: 'Set your top 5 for a week', action: 'setFounderFocus',
    description: 'Super admins: set your top 5 for a week — each item ranked 1–5 and either a plan item (plan_item_id from docket_plan), a task (task_id from docket_tasks) or a free note; a note may also sit beside an id. This REPLACES your whole top 5 for that week; send items: [] to clear it. A week that is over can\'t be changed. Read it back with docket_plan report=founders (week = this, last or the week-ending date).',
    recorded: 'it replaces your top 5 for that week (the other founder\'s list is untouched).',
    params: {
      week: { ...FOCUS_WEEK, about: 'this (default), next, or a date YYYY-MM-DD for the week holding it.' },
      items: { ...FOCUS_ITEMS, about: 'Up to 5 items: { rank 1–5, plan_item_id? | task_id?, note? }. [] clears the week.' },
    },
    required: ['items'],
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
      plan_item_id: { ...PLAN_ITEM, about: 'Plan link: a theme, milestone or result id from docket_plan (proposed or agreed). Omit for an unplanned task.' },
      handoff_to_department_id: { ...HANDOFF_ID, about: 'Make it a hand-off to another team: that department\'s id (from docket_tasks report=people). You stay the owner; the deadline is the hand-off date.' },
      handoff_to_employee_id: { ...HANDOFF_ID, about: 'Optional named receiver of the hand-off (an employee id); alone, their team becomes the receiving team.' },
    },
    required: ['title'],
    finalize: d => (d.owner_employee_id ? d : { ...d, assign_self: true }),
  }),
  writeTool({
    name: 'docket_update_task', title: 'Edit a Docket task', action: 'updateTask',
    description: 'Change a task\'s title, description, priority, owner or plan link, or set a FIRST deadline on a task that has none (to move an existing deadline use docket_revise_deadline). Status changes use docket_set_status. A sub-task follows its parent\'s plan link.',
    params: {
      id: TASK,
      title: { ...longText(200), about: 'New title.' },
      description: { ...optText(4000), about: 'New description.' },
      priority: { ...PRIORITY, about: 'New priority.' },
      owner_employee_id: { ...T.uuid, about: 'New owner (employee id).' },
      deadline: { ...T.date, about: 'First deadline, only if the task has none yet.' },
      plan_item_id: { ...PLAN_ITEM, about: 'New plan link (an id from docket_plan), or null to make the task unplanned. Not on a sub-task.' },
      handoff_to_department_id: { ...HANDOFF_ID, about: 'Hand this task off to another team (department id), or null to stop it being a hand-off. Changing it voids an acceptance.' },
      handoff_to_employee_id: { ...HANDOFF_ID, about: 'The hand-off\'s named receiver (employee id), or null for the whole receiving team. Changing it voids an acceptance.' },
    },
    required: ['id'],
    check: d => (Object.keys(d).length > 1 ? null : 'give at least one field to change besides `id`'),
    guard: (t, d) => notAbandoned(t) || (d.deadline && (t.deadline || t.revised_deadline) ? 'this task already has a deadline; move it with docket_revise_deadline (a reason is required).' : null),
  }),
  writeTool({
    name: 'docket_set_status', title: 'Set a Docket task\'s status', action: 'changeStatus',
    description: 'Move a task to not_started, in_progress, done or blocked (this also reopens an abandoned task). Marking done a task that is still waiting on open tasks is refused with `waiting_on` and the list of blockers; confirm with the person, then call again with force: true.',
    params: { id: TASK, status: { ...STATUS, about: 'New status.' }, note: { ...optText(500), about: 'Optional note for the history.' },
      force: { ...T.bool, about: 'true marks the task done even though it is still waiting on open tasks (the Docket app asks the same confirmation).' } },
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
  // F9 R8 — accept a hand-off given to you or your team (spec §4.6). Docket checks you are on the receiving side.
  writeTool({
    name: 'docket_accept_handoff', title: 'Accept a Docket hand-off', action: 'acceptHandoff',
    description: 'Accept a hand-off that is given to you or to your team (find them with docket_tasks report=incoming). If no one was named, you become the named receiver. Accepting again does nothing.',
    recorded: 'recorded in the task\'s history.',
    params: { id: TASK },
    required: ['id'],
  }),
  // F9 R9a — apply a plan template (spec §11): every step is created through Docket's normal path (plan items +
  // tasks, history, the week's commitments) in ONE transaction — all or nothing. Docket checks the rights
  // (founders' templates: super admins; leads' templates: the anchor milestone's owner) and every role.
  writeTool({
    name: 'docket_apply_template', title: 'Apply a Docket plan template', action: 'applyTemplate',
    description: 'Create a template\'s milestones, results and tasks under a plan item: a founders template under an agreed theme, a leads template under an agreed milestone you own. Each step is dated anchor_date + its day offset and owned by the person you map to its role. Read the template\'s roles first with docket_plan report=template; find people with docket_tasks report=people. Everything is created or nothing is.',
    recorded: 'every created item and task records it in its history.',
    params: {
      id: { ...T.uuid, about: 'The template id (from docket_plan report=templates).' },
      anchor_id: { ...T.uuid, about: 'The theme (founders template) or milestone (leads template) to create under — an id from docket_plan.' },
      anchor_date: { ...T.date, about: 'Day 0, YYYY-MM-DD: each step is dated this plus its offset.' },
      roles: { ...TEMPLATE_ROLES, about: 'Every role in the template → the employee who owns its steps, e.g. { "Owner": "<employee id>" }.' },
    },
    required: ['id', 'anchor_id', 'anchor_date', 'roles'],
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
