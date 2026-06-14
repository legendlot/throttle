'use client';
/* throttleApi — live reads/writes against the brand schema (supabaseBrand,
   RLS-enforced) + the throttleops worker (workerFetch), normalized to the
   shapes the redesigned screens render. Every read is best-effort: on any
   error or empty result the caller falls back to seed data, so a screen is
   never blank or broken. */
import { supabaseBrand, workerFetch } from '@throttle/db';
import { STAGES, REQ_TYPES, initialsOf } from './throttleData';

const ACTIVE_STAGES = STAGES.map(s => s.value);

// ── relative-time + date helpers ─────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}
export function relAge(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3.6e6);
  if (h < 1) return `${Math.max(1, Math.floor(diff / 6e4))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export function ageTone(iso) {
  if (!iso) return 'ok';
  const days = (Date.now() - new Date(iso).getTime()) / 8.64e7;
  return days > 2 ? 'bad' : days > 1 ? 'warn' : 'ok';
}
function dueAge(due) {
  if (!due) return null;
  const ms = new Date(due).getTime() - Date.now();
  if (isNaN(ms)) return null;
  if (ms < 0) return 'crit';
  if (ms < 48 * 3.6e6) return 'warn';
  return null;
}

// ── request type resolver (aliases legacy → prototype vocabulary) ─
const TYPE_ALIAS = {
  '3d_motion': 'motion_3d', '3d': 'motion_3d', photo_video_new: 'photo_video',
  social: 'social_media', design: 'design_brand', copy: 'copy_script',
  ad: 'advertising', campaign: 'brand_initiative', deck: 'design_brand',
};
export function reqTypeOf(type) {
  const key = REQ_TYPES[type] ? type : (TYPE_ALIAS[type] && REQ_TYPES[TYPE_ALIAS[type]] ? TYPE_ALIAS[type] : null);
  return key ? { key, ...REQ_TYPES[key] } : { key: type, label: (type || 'request').replace(/_/g, ' '), icon: 'box' };
}

// ── users ────────────────────────────────────────────────────────
export async function fetchUsers(session) {
  try {
    const { data, error } = await supabaseBrand.from('users').select('id,name,role,discipline');
    if (error || !data) return null;
    const list = data.map(u => ({ ...u, initial: initialsOf(u.name) }));
    const byId = Object.fromEntries(list.map(u => [u.id, u]));
    return { list, byId };
  } catch (_) { return null; }
}

// ── tasks (board / sprints) ──────────────────────────────────────
export async function fetchTasks(session, usersById = {}) {
  try {
    const { data, error } = await supabaseBrand.from('tasks')
      .select('id,task_number,title,stage,priority,deliverable_type,type,product_code,due_date,blocked_reason,sprint_id,task_assignees(user_id,is_owner)')
      .in('stage', ACTIVE_STAGES)
      .order('task_number', { ascending: false });
    if (error || !data || !data.length) return null;
    return data.map(t => {
      const assignees = t.task_assignees || [];
      const owner = assignees.find(a => a.is_owner) || assignees[0];
      const ownerUser = owner ? usersById[owner.user_id] : null;
      return {
        id: t.id,
        num: t.task_number ?? 0,
        title: t.title,
        stage: t.stage,
        priority: t.priority || 'medium',
        type: t.deliverable_type || t.type || 'graphic',
        product: t.product_code ? String(t.product_code).toUpperCase() : null,
        ownerId: owner?.user_id || null,
        ownerName: ownerUser?.name || null,
        ownerInitial: ownerUser ? ownerUser.initial : (owner ? '·' : null),
        collabs: Math.max(0, assignees.length - 1),
        due: shortDate(t.due_date),
        age: dueAge(t.due_date),
        blocked: t.blocked_reason || null,
        sprint_id: t.sprint_id || null,
      };
    });
  } catch (_) { return null; }
}

// ── requests ─────────────────────────────────────────────────────
export async function fetchRequests(session, usersById = {}) {
  try {
    const { data, error } = await supabaseBrand.from('requests')
      .select('id,type,title,status,requester_id,created_at,review_note,template_data')
      .order('created_at', { ascending: false }).limit(60);
    if (error || !data || !data.length) return null;
    const ids = data.map(r => r.id);
    let prodByReq = {};
    try {
      const { data: rp } = await supabaseBrand.from('request_products').select('request_id,product_name').in('request_id', ids);
      (rp || []).forEach(p => { (prodByReq[p.request_id] = prodByReq[p.request_id] || []).push(String(p.product_name).toUpperCase()); });
    } catch (_) {}
    return data.map(r => {
      const u = usersById[r.requester_id];
      const products = prodByReq[r.id] || [];
      const td = r.template_data || {};
      const items = Array.isArray(td.items) ? td.items.length : (products.length > 1 ? products.length : null);
      return {
        id: r.id, _id: r.id, type: r.type, title: r.title, status: r.status,
        who: u?.name || 'Requester', wi: u ? u.initial : '?',
        products, items,
        note: (r.status === 'info_needed' || r.status === 'rejected') ? (r.review_note || null) : null,
        date: shortDate(r.created_at), age: relAge(r.created_at), ageTone: ageTone(r.created_at),
        requester_id: r.requester_id,
      };
    });
  } catch (_) { return null; }
}

// ── sprints ──────────────────────────────────────────────────────
export async function fetchSprints(session) {
  try {
    const { data, error } = await supabaseBrand.from('sprints')
      .select('id,name,start_date,end_date,status,health_score').order('start_date', { ascending: false }).limit(8);
    if (error || !data || !data.length) return null;
    return data.map(s => {
      const hs = s.health_score || {};
      const committed = hs.total_tasks ?? hs.committed ?? 0;
      const done = hs.done_count ?? hs.done ?? 0;
      const spill = hs.spillover_count ?? 0;
      const range = `${shortDate(s.start_date)} – ${shortDate(s.end_date)}`;
      return { id: s.id, _id: s.id, name: s.name, range, status: s.status, committed, done, spill,
        shortId: String(s.name || '').replace(/^Sprint\s+/i, '') };
    });
  } catch (_) { return null; }
}

// ── dashboard stats (admin/lead) ─────────────────────────────────
export async function fetchDashboardStats(session) {
  try { return await workerFetch('getDashboardStats', {}, session.access_token); }
  catch (_) { return null; }
}
export async function fetchTeamWorkload(session, sprintId) {
  try { return await workerFetch('getTeamWorkload', sprintId ? { sprintId } : {}, session.access_token); }
  catch (_) { return null; }
}

// ── task drawer activity / comments ──────────────────────────────
export async function fetchTaskActivity(session, taskId) {
  try { const r = await workerFetch('getTaskActivity', { taskId }, session.access_token); return r?.activity || r?.data?.activity || []; }
  catch (_) { return null; }
}
export async function postComment(session, taskId, comment) {
  return workerFetch('addComment', { taskId, comment }, session.access_token);
}
export async function moveTaskStage(session, taskId, stage, blockedReason) {
  const body = { task_id: taskId, stage };
  if (blockedReason) body.blocked_reason = blockedReason;
  return workerFetch('updateTaskStage', body, session.access_token);
}

// ── request actions ──────────────────────────────────────────────
export async function actOnRequest(session, requestId, status, note) {
  if (status === 'approved') return workerFetch('approveRequest', { request_id: requestId, note: note || '' }, session.access_token);
  if (status === 'info_needed') return workerFetch('requestMoreInfo', { request_id: requestId, note: note || 'More information needed.' }, session.access_token);
  if (status === 'rejected') return workerFetch('rejectRequest', { request_id: requestId, note: note || 'Rejected.' }, session.access_token);
  throw new Error('unknown action');
}

// ── ageing config (settings) ─────────────────────────────────────
export async function fetchAgeingConfig(session) {
  try { const r = await workerFetch('getAgeingConfig', {}, session.access_token); return r?.config || r?.data?.config || null; }
  catch (_) { return null; }
}

// ── social feed ──────────────────────────────────────────────────
export async function fetchSocialFeed(session, fromDate, toDate) {
  try { const r = await workerFetch('getSocialFeed', { from_date: fromDate, to_date: toDate }, session.access_token); return r?.feed || r?.data?.feed || null; }
  catch (_) { return null; }
}
export async function fetchChannels(session) {
  try { const r = await workerFetch('getChannels', {}, session.access_token); return r?.channels || r?.data?.channels || null; }
  catch (_) { return null; }
}
const PROTO_STATUS_TO_REAL = { posted: 'published', scheduled: 'approved', review: 'draft', draft: 'draft' };
const PLATFORM_CONTENT = {
  instagram: ['reel', 'carousel', 'story', 'photo'], youtube: ['video', 'short'],
  linkedin: ['post', 'article', 'video'], whatsapp: ['broadcast', 'post'],
};
export async function createSocialPostLive(session, { title, dateISO, time, status, productCode, channelId, platform, fmt }) {
  const ct = String(fmt || '').toLowerCase();
  const allowed = PLATFORM_CONTENT[platform] || [];
  const content_type = allowed.includes(ct) ? ct : (allowed[0] || undefined);
  const body = {
    title: title || 'Untitled post', scheduled_date: dateISO,
    scheduled_time: time ? (time.length === 5 ? time + ':00' : time) : undefined,
    status: PROTO_STATUS_TO_REAL[status] || 'draft',
    product_code: productCode || undefined,
    variants: channelId ? [{ channel_id: channelId, content_type }] : [],
  };
  return workerFetch('createSocialPost', body, session.access_token);
}
export async function moveSocialPostLive(session, postId, dateISO) {
  return workerFetch('updateSocialPost', { post_id: postId, scheduled_date: dateISO }, session.access_token);
}
