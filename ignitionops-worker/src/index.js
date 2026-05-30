/**
 * Ignition — ignitionops Cloudflare Worker
 * ignitionops.afshaan.workers.dev
 *
 * API for the Influencer Marketing CRM at ignition.legendoftoys.com.
 * Sibling to lotopsproxy (Garage/Redline/Scanner), throttleops (Throttle),
 * and csops (Pitstop).
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * Spec:  systems/ignition.md
 *        05_Throttle/apps/ignition/DESIGN.md
 */

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}
function ok(data) {
  return json({ ok: true, data });
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'ignition',
      'Content-Profile': 'ignition',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function sbStore(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'store',
      'Content-Profile': 'store',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profileRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`,
    env,
  );
  if (!profileRes.ok || !profileRes.data?.[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;

  const rolesRes = await sbStore(
    `/rest/v1/roles?role_id=eq.${encodeURIComponent(profile.role)}&select=permissions&limit=1`,
    env,
  );
  const permissions = (rolesRes.ok && rolesRes.data?.[0]?.permissions) || {};

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    fullName: profile.full_name,
    permissions,
    // Echo the raw JWT so sibling-worker calls (csops createTicket) can re-use it.
    bearer: token,
  };
}

function requirePerm(perm, auth) {
  if (!auth?.permissions?.[perm]) {
    return err(`Forbidden — missing permission: ${perm}`, 403);
  }
  return null;
}

// ── Stage state machine ────────────────────────────────────────────────────

const STAGES = [
  'identified','invited','engaged','negotiating','agreed',
  'shipped','delivered','script_review','script_signed_off',
  'scheduled','live','tracking','closed',
  'declined','ghosted','dropped',
];

const TERMINAL_FAIL = new Set(['declined','ghosted','dropped']);

function allowedTransitions(stage) {
  switch (stage) {
    case 'identified':         return ['invited','declined','dropped'];
    case 'invited':            return ['engaged','ghosted','declined'];
    case 'engaged':            return ['negotiating','ghosted','declined'];
    case 'negotiating':        return ['agreed','declined','dropped'];
    case 'agreed':             return ['shipped','dropped'];
    case 'shipped':            return ['delivered','dropped'];
    case 'delivered':          return ['script_review','dropped'];
    case 'script_review':      return ['script_signed_off','dropped'];
    case 'script_signed_off':  return ['scheduled','dropped'];
    case 'scheduled':          return ['live','dropped'];
    case 'live':               return ['tracking','dropped'];
    case 'tracking':           return ['closed'];
    case 'closed':             return [];
    case 'declined':
    case 'ghosted':
    case 'dropped':            return ['closed'];
    default:                   return [];
  }
}

// ── Util ────────────────────────────────────────────────────────────────────

function pickPatch(body, allowed) {
  if (!body || typeof body.patch !== 'object') return {};
  const patch = {};
  for (const k of allowed) {
    if (k in body.patch) patch[k] = body.patch[k];
  }
  return patch;
}

function nowIso() { return new Date().toISOString(); }

async function mintEngagementNo(env, year) {
  const yyyy = year || String(new Date().getUTCFullYear());
  const r = await sbStore(`/rest/v1/rpc/next_engagement_seq`, env, {
    method: 'POST',
    headers: { 'Accept-Profile': 'ignition', 'Content-Profile': 'ignition' },
    body: JSON.stringify({ p_year: yyyy }),
  });
  if (!r.ok || typeof r.data !== 'number') return null;
  const seq = String(r.data).padStart(5, '0');
  return `IGN-${yyyy}-${seq}`;
}

async function writeHistory(env, engagement_id, action, from, to, note, actor) {
  return sb(`/rest/v1/engagement_history`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id, action, stage_from: from || null, stage_to: to || null,
      note: note || null, actor: actor || null,
    }]),
    prefer: 'return=minimal',
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GET ACTIONS
// ────────────────────────────────────────────────────────────────────────────

async function getInfluencers(url, auth, env) {
  const tab = (url.searchParams.get('tab') || 'master').toLowerCase();
  const type = url.searchParams.get('type');
  const category = url.searchParams.get('category');
  const location = url.searchParams.get('location');
  const status = url.searchParams.get('status');
  const rating = url.searchParams.get('rating');
  const search = (url.searchParams.get('search') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (tab === 'master')   filters.push('list_status=eq.master');
  else if (tab === 'b_list') filters.push('list_status=eq.b_list');
  else if (tab === 'archived') filters.push('list_status=eq.archived');
  if (type)     filters.push(`influencer_type=eq.${encodeURIComponent(type)}`);
  if (location) filters.push(`location=ilike.*${encodeURIComponent(location)}*`);
  if (rating)   filters.push(`quality_rating=eq.${encodeURIComponent(rating)}`);
  if (category) filters.push(`categories=cs.{${encodeURIComponent(category)}}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(channel_name.ilike.*${s}*,person_name.ilike.*${s}*,email.ilike.*${s}*,contact_number.ilike.*${s}*,influencer_code.ilike.*${s}*)`);
  }

  const qs = filters.join('&');
  const r = await sb(
    `/rest/v1/influencers?${qs}&select=*&order=updated_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ influencers: r.data || [], offset, limit });
}

async function getInfluencer(url, auth, env) {
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id && !code) return err('id or code required', 400);
  const filter = id ? `id=eq.${id}` : `influencer_code=eq.${encodeURIComponent(code)}`;
  const r = await sb(`/rest/v1/influencers?${filter}&select=*&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  const inf = r.data?.[0];
  if (!inf) return err('not_found', 404);

  // Pull history of engagements
  const er = await sb(
    `/rest/v1/engagements?influencer_id=eq.${inf.id}&select=*&order=created_at.desc`,
    env,
  );
  return ok({ influencer: inf, engagements: er.data || [] });
}

async function getEngagements(url, auth, env) {
  const type = url.searchParams.get('type');
  const stage = url.searchParams.get('stage');
  const product = url.searchParams.get('product');
  const dealType = url.searchParams.get('deal_type');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const search = (url.searchParams.get('search') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (type && type !== 'all') filters.push(`engagement_type=eq.${encodeURIComponent(type)}`);
  if (stage)    filters.push(`stage=eq.${encodeURIComponent(stage)}`);
  if (product)  filters.push(`product_code=eq.${encodeURIComponent(product)}`);
  if (dealType) filters.push(`deal_type=eq.${encodeURIComponent(dealType)}`);
  if (dateFrom) filters.push(`post_date=gte.${dateFrom}`);
  if (dateTo)   filters.push(`post_date=lte.${dateTo}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(engagement_no.ilike.*${s}*,video_link.ilike.*${s}*,tracking_id.ilike.*${s}*,shipping_order_id.ilike.*${s}*)`);
  }

  const qs = filters.join('&');
  const r = await sb(
    `/rest/v1/engagements?${qs}&select=*,influencer:influencer_id(influencer_code,channel_name,person_name,influencer_type)&order=updated_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ engagements: r.data || [], offset, limit });
}

async function getEngagement(url, auth, env) {
  const id = url.searchParams.get('id');
  const eno = url.searchParams.get('engagement_no');
  if (!id && !eno) return err('id or engagement_no required', 400);
  const filter = id ? `id=eq.${id}` : `engagement_no=eq.${encodeURIComponent(eno)}`;
  const r = await sb(
    `/rest/v1/engagements?${filter}&select=*,influencer:influencer_id(*)&limit=1`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const eng = r.data?.[0];
  if (!eng) return err('not_found', 404);

  const [hr, nr, ar] = await Promise.all([
    sb(`/rest/v1/engagement_history?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_notes?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_attachments?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
  ]);

  return ok({
    engagement: eng,
    history: hr.data || [],
    notes: nr.data || [],
    attachments: ar.data || [],
    allowed_next: allowedTransitions(eng.stage),
  });
}

async function getRoster(url, auth, env) {
  // Derived: influencers who have at least one engagement past 'shipped'.
  const rating = url.searchParams.get('rating');
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (rating) filters.push(`quality_rating=eq.${encodeURIComponent(rating)}`);
  filters.push('list_status=neq.archived');

  const r = await sb(
    `/rest/v1/influencers?${filters.join('&')}&select=*,engagements:engagements!influencer_id(id,engagement_no,stage,post_date,closed_reason)&order=updated_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // Roster = influencers with at least one engagement in shipped+ stages.
  const PROGRESSED = new Set(['shipped','delivered','script_review','script_signed_off','scheduled','live','tracking','closed']);
  const rows = (r.data || []).filter(i => (i.engagements || []).some(e => PROGRESSED.has(e.stage)));
  return ok({ roster: rows, offset, limit });
}

async function getDiscountCodes(url, auth, env) {
  const utilized = url.searchParams.get('utilized');
  const pool = url.searchParams.get('pool');
  const engagementId = url.searchParams.get('engagement_id');
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (utilized != null) filters.push(`utilized=eq.${utilized === 'true'}`);
  if (pool)             filters.push(`pool_label=eq.${encodeURIComponent(pool)}`);
  if (engagementId)     filters.push(`engagement_id=eq.${engagementId}`);

  const r = await sb(
    `/rest/v1/discount_codes?${filters.join('&')}&select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  return ok({ codes: r.data || [], offset, limit });
}

// Roll up the embedded engagements of a campaign into summary numbers.
// PostgREST returns numeric columns as strings — coerce with Number().
function campaignRollup(c) {
  const engs = c.engagements || [];
  const num = v => Number(v) || 0;
  const POSTED = new Set(['live', 'tracking', 'closed']);
  const spend = engs.reduce((s, e) => s + (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount)), 0);
  return {
    linked_count: engs.length,
    posted_count: engs.filter(e => POSTED.has(e.stage)).length,
    spend,
    views: engs.reduce((s, e) => s + num(e.views), 0),
    orders: engs.reduce((s, e) => s + num(e.orders), 0),
  };
}

const CAMPAIGN_ENG_SELECT =
  'engagements:engagements!campaign_id(id,engagement_no,engagement_type,stage,product_code,product_variant,payment_amount,total_cost,views,orders,post_date,expected_post_date,video_link)';

async function getCampaigns(url, auth, env) {
  const status = url.searchParams.get('status');
  const filters = [];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  const r = await sb(
    `/rest/v1/campaigns?${filters.join('&')}&select=*,influencer:influencer_id(influencer_code,channel_name,person_name),${CAMPAIGN_ENG_SELECT}&order=created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const campaigns = (r.data || []).map(c => ({ ...c, rollup: campaignRollup(c) }));
  return ok({ campaigns });
}

async function getCampaign(url, auth, env) {
  const id = url.searchParams.get('id');
  const no = url.searchParams.get('campaign_no');
  if (!id && !no) return err('id or campaign_no required', 400);
  const filter = id ? `id=eq.${id}` : `campaign_no=eq.${encodeURIComponent(no)}`;
  const r = await sb(
    `/rest/v1/campaigns?${filter}&select=*,influencer:influencer_id(*),${CAMPAIGN_ENG_SELECT}&limit=1`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const c = r.data?.[0];
  if (!c) return err('not_found', 404);
  return ok({ campaign: { ...c, rollup: campaignRollup(c) } });
}

async function getKpis(url, auth, env) {
  // Header tile counts. Three quick queries via Prefer: count.
  async function count(filter) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/engagements?${filter}&select=id`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept-Profile': 'ignition',
        'Prefer': 'count=exact',
        'Range-Unit': 'items',
        'Range': '0-0',
      },
    });
    const cr = res.headers.get('content-range');
    if (!cr) return 0;
    const m = cr.match(/\/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }
  const ACTIVE = "stage=in.(invited,engaged,negotiating,agreed,shipped,delivered,script_review,script_signed_off,scheduled,live,tracking)";
  const [active, live, closed, ghosted, overdue] = await Promise.all([
    count(ACTIVE),
    count('stage=eq.live'),
    count('stage=eq.closed'),
    count('stage=eq.ghosted'),
    count(overdueFilter()),
  ]);
  return ok({ active, live, closed, ghosted, overdue });
}

// ── Overdue-post detection (auto-rating signal) ──────────────────────────────
// An engagement is "overdue" when its expected post date has passed by more
// than `days` and it still hasn't gone live (no post_date, not in a posted/
// terminal stage). Drives the dashboard signal + the flagOverdueRatings sweep.
const OVERDUE_DEFAULT_DAYS = 7;
const POSTED_OR_TERMINAL = ['live', 'tracking', 'closed', 'declined', 'ghosted', 'dropped'];

function overdueCutoffDate(days) {
  const n = Number(days) || OVERDUE_DEFAULT_DAYS;
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function overdueFilter(days) {
  const cutoff = overdueCutoffDate(days);
  return `expected_post_date=lt.${cutoff}&post_date=is.null&stage=not.in.(${POSTED_OR_TERMINAL.join(',')})`;
}

async function getOverdueEngagements(url, auth, env) {
  const days = url.searchParams.get('days') || OVERDUE_DEFAULT_DAYS;
  const r = await sb(
    `/rest/v1/engagements?${overdueFilter(days)}&select=id,engagement_no,stage,product_code,product_variant,expected_post_date,influencer:influencer_id(id,influencer_code,channel_name,person_name,quality_rating)&order=expected_post_date.asc&limit=500`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const today = new Date().toISOString().slice(0, 10);
  const rows = (r.data || []).map(e => ({
    ...e,
    days_overdue: e.expected_post_date
      ? Math.floor((Date.parse(today) - Date.parse(e.expected_post_date)) / 86400000)
      : null,
  }));
  return ok({ overdue: rows, days: Number(days) || OVERDUE_DEFAULT_DAYS });
}

// ── Reports (spend / ROAS / CPM / top performers) ───────────────────────────
// One range-scoped query over engagements; all aggregation happens in JS to
// stay within the 50-subrequest budget. Gated on ignition_reports_view.
async function getReports(url, auth, env) {
  const gate = requirePerm('ignition_reports_view', auth); if (gate) return gate;
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const filters = [];
  if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`);

  const r = await sb(
    `/rest/v1/engagements?${filters.join('&')}&select=engagement_no,created_at,post_date,product_code,engagement_type,deal_type,payment_amount,total_cost,ad_spend,commission_amount,views,orders,conversions_value,cpm,actual_roas,roas_on_ad_spend,influencer:influencer_id(influencer_code,channel_name,person_name)&order=created_at.desc&limit=5000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = r.data || [];
  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  const roasOf = e => (e.actual_roas != null ? num(e.actual_roas) : (e.roas_on_ad_spend != null ? num(e.roas_on_ad_spend) : null));

  // Spend / orders / views by month (post_date if posted, else created_at).
  const byMonthMap = {};
  const byProductMap = {};
  let totalSpend = 0, totalOrders = 0, totalViews = 0, totalConv = 0;
  let cpmSum = 0, cpmN = 0, roasSum = 0, roasN = 0;

  const ROAS_BUCKETS = [{ k: '<1', lo: -Infinity, hi: 1 }, { k: '1–2', lo: 1, hi: 2 }, { k: '2–3', lo: 2, hi: 3 }, { k: '3–5', lo: 3, hi: 5 }, { k: '5+', lo: 5, hi: Infinity }];
  const CPM_BUCKETS = [{ k: '<50', lo: -Infinity, hi: 50 }, { k: '50–100', lo: 50, hi: 100 }, { k: '100–200', lo: 100, hi: 200 }, { k: '200–500', lo: 200, hi: 500 }, { k: '500+', lo: 500, hi: Infinity }];
  const roasDist = Object.fromEntries(ROAS_BUCKETS.map(b => [b.k, 0]));
  const cpmDist = Object.fromEntries(CPM_BUCKETS.map(b => [b.k, 0]));
  const bucketOf = (buckets, v) => (buckets.find(b => v >= b.lo && v < b.hi) || buckets[buckets.length - 1]).k;

  for (const e of rows) {
    const spend = spendOf(e);
    const orders = num(e.orders), views = num(e.views), conv = num(e.conversions_value);
    totalSpend += spend; totalOrders += orders; totalViews += views; totalConv += conv;

    const month = (e.post_date || e.created_at || '').slice(0, 7);
    if (month) {
      const m = byMonthMap[month] || (byMonthMap[month] = { month, spend: 0, orders: 0, views: 0, deals: 0 });
      m.spend += spend; m.orders += orders; m.views += views; m.deals += 1;
    }
    const prod = e.product_code || '—';
    const p = byProductMap[prod] || (byProductMap[prod] = { name: prod, deals: 0, spend: 0, orders: 0, views: 0 });
    p.deals += 1; p.spend += spend; p.orders += orders; p.views += views;

    if (e.cpm != null) { const c = num(e.cpm); cpmSum += c; cpmN++; cpmDist[bucketOf(CPM_BUCKETS, c)]++; }
    const roas = roasOf(e);
    if (roas != null) { roasSum += roas; roasN++; roasDist[bucketOf(ROAS_BUCKETS, roas)]++; }
  }

  const byMonth = Object.values(byMonthMap).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ ...m, spend: Math.round(m.spend) }));
  const byProduct = Object.values(byProductMap).sort((a, b) => b.spend - a.spend)
    .map(p => ({ ...p, spend: Math.round(p.spend) }));

  const topPerformers = rows
    .map(e => ({
      engagement_no: e.engagement_no,
      influencer: e.influencer?.channel_name || e.influencer?.person_name || e.influencer?.influencer_code || '—',
      product: e.product_code || '—',
      orders: num(e.orders),
      conversions_value: Math.round(num(e.conversions_value)),
      spend: Math.round(spendOf(e)),
      roas: roasOf(e),
    }))
    .filter(e => e.orders > 0 || e.conversions_value > 0 || e.roas != null)
    .sort((a, b) => (b.conversions_value - a.conversions_value) || (b.orders - a.orders))
    .slice(0, 15);

  return ok({
    range: { from: from || null, to: to || null, total_deals: rows.length },
    totals: {
      deals: rows.length,
      spend: Math.round(totalSpend),
      orders: totalOrders,
      views: totalViews,
      conversions_value: Math.round(totalConv),
      avg_cpm: cpmN ? Math.round((cpmSum / cpmN) * 100) / 100 : null,
      avg_roas: roasN ? Math.round((roasSum / roasN) * 100) / 100 : null,
    },
    by_month: byMonth,
    by_product: byProduct,
    roas_distribution: ROAS_BUCKETS.map(b => ({ bucket: b.k, count: roasDist[b.k] })),
    cpm_distribution: CPM_BUCKETS.map(b => ({ bucket: b.k, count: cpmDist[b.k] })),
    top_performers: topPerformers,
  });
}

async function getCatalogs(url, auth, env) {
  // Static enums + product list from store schema.
  const productsRes = await sbStore(
    `/rest/v1/product_master?select=name,sku&order=name`,
    env,
  ).catch(() => ({ data: [] }));
  return ok({
    influencer_types: ['nano','micro','macro','brand','store'],
    deal_types: ['paid','barter','affiliate','paid_plus_affiliate'],
    payment_terms: ['advance','on_draft','on_release','n_a'],
    engagement_types: ['video_tracking','ugc'],
    stages: STAGES,
    closed_reasons: ['completed','ghosted','declined','dropped','historical_import'],
    list_statuses: ['master','b_list','archived'],
    quality_ratings: ['green','yellow','red','unrated'],
    directed_to: ['website','amazon','flipkart'],
    products: productsRes.data || [],
  });
}

async function getMe(url, auth, env) {
  return ok({
    userId: auth.userId,
    email: auth.email,
    role: auth.role,
    fullName: auth.fullName,
    permissions: auth.permissions,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// POST ACTIONS
// ────────────────────────────────────────────────────────────────────────────

const INFLUENCER_FIELDS = [
  'channel_name','person_name','channel_link','channel_platform',
  'influencer_type','categories','reach','audience','location',
  'contact_number','address','email','contact_poc_type','contact_poc_name',
  'first_invite_sent_at','list_status','quality_rating','rating_notes',
];

const ENGAGEMENT_FIELDS = [
  'engagement_type','campaign_id','product_code','product_variant',
  'deal_type','payment_terms','payment_amount','affiliate_pct','commission_amount',
  'ad_spend','goodies_cost','shipping_cost','return_cost','cpm',
  'expected_post_date','post_date','video_link','utm_link',
  'utm_source','utm_medium','utm_campaign',
  'views','likes','comments','shares','impressions','sessions','orders',
  'conversions_value','roas_on_ad_spend','actual_roas','orders_cc',
  'shipping_order_id','tracking_id','shipping_month','shipping_date','directed_to',
];

async function createInfluencer(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;

  // influencer_code is required and immutable (RULE-IGN-001).
  const code = String(body.influencer_code || '').trim();
  if (!code) return err('influencer_code required', 400);

  const row = { influencer_code: code, created_by: auth.userId };
  for (const k of INFLUENCER_FIELDS) {
    if (k in body) row[k] = body[k];
  }
  const r = await sb(`/rest/v1/influencers`, env, {
    method: 'POST',
    body: JSON.stringify([row]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateInfluencer(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  const patch = pickPatch(body, INFLUENCER_FIELDS);
  patch.updated_at = nowIso();
  // influencer_code is immutable: strip even if it sneaks in via patch.
  delete patch.influencer_code;
  if (Object.keys(patch).length === 1 /* only updated_at */) return err('no_patch', 400);

  const r = await sb(`/rest/v1/influencers?id=eq.${body.influencer_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function createEngagement(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!body.engagement_type) return err('engagement_type required', 400);
  if (!body.deal_type) return err('deal_type required', 400);

  const eno = await mintEngagementNo(env);
  if (!eno) return err('failed_to_mint_engagement_no', 500);

  const row = {
    engagement_no: eno,
    influencer_id: body.influencer_id,
    stage: 'identified',
    created_by: auth.userId,
  };
  for (const k of ENGAGEMENT_FIELDS) if (k in body) row[k] = body[k];

  const r = await sb(`/rest/v1/engagements`, env, {
    method: 'POST',
    body: JSON.stringify([row]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const eng = r.data?.[0];
  await writeHistory(env, eng.id, 'create', null, 'identified', null, auth.userId);
  return ok({ engagement_no: eno, id: eng.id });
}

async function updateEngagement(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const patch = pickPatch(body, ENGAGEMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);

  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function advanceStage(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.to_stage) return err('to_stage required', 400);

  const cur = await sb(
    `/rest/v1/engagements?id=eq.${body.engagement_id}&select=stage&limit=1`, env,
  );
  if (!cur.ok || !cur.data?.[0]) return err('not_found', 404);
  const from = cur.data[0].stage;
  const allowed = allowedTransitions(from);
  if (!allowed.includes(body.to_stage)) {
    return err(`illegal_transition: ${from} → ${body.to_stage}`, 422);
  }

  const patch = { stage: body.to_stage, updated_at: nowIso() };
  if (body.to_stage === 'closed') {
    patch.closed_at = nowIso();
    patch.closed_reason = body.closed_reason || (TERMINAL_FAIL.has(from) ? from : 'completed');
  }
  // Allow incidental field updates in the same call (e.g. video_link on go-live).
  const extra = pickPatch(body, ENGAGEMENT_FIELDS);
  Object.assign(patch, extra);

  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);

  await writeHistory(env, body.engagement_id, 'advance_stage', from, body.to_stage, body.note || null, auth.userId);
  return ok({ stage: body.to_stage, allowed_next: allowedTransitions(body.to_stage) });
}

async function closeEngagement(body, auth, env) {
  body.to_stage = 'closed';
  return advanceStage(body, auth, env);
}

async function setRating(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!['green','yellow','red','unrated'].includes(body.rating)) return err('invalid_rating', 400);

  const r = await sb(`/rest/v1/influencers?id=eq.${body.influencer_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      quality_rating: body.rating,
      rating_notes: body.rating_notes || null,
      updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function addNote(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.body) return err('body required', 400);
  if (!body.engagement_id && !body.influencer_id) return err('engagement_id or influencer_id required', 400);
  const r = await sb(`/rest/v1/engagement_notes`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id: body.engagement_id || null,
      influencer_id: body.influencer_id || null,
      body: body.body,
      actor: auth.userId,
    }]),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function addAttachment(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.url) return err('url required', 400);
  const r = await sb(`/rest/v1/engagement_attachments`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id: body.engagement_id,
      kind: body.kind || 'proof',
      url: body.url,
      name: body.name || null,
      created_by: auth.userId,
    }]),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function assignDiscountCode(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.code) return err('code required', 400);
  if (!body.engagement_id) return err('engagement_id required', 400);
  const r = await sb(`/rest/v1/discount_codes?code=eq.${encodeURIComponent(body.code)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ engagement_id: body.engagement_id }),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

// Sibling-worker call: open a Pitstop ticket for a damaged shipment.
async function openPitstopTicket(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.issue_description) return err('issue_description required', 400);

  // Load engagement + influencer for prefill
  const er = await sb(
    `/rest/v1/engagements?id=eq.${body.engagement_id}&select=*,influencer:influencer_id(channel_name,person_name,contact_number,email)&limit=1`,
    env,
  );
  if (!er.ok || !er.data?.[0]) return err('engagement_not_found', 404);
  const eng = er.data[0];
  if (eng.cs_ticket_no) {
    return err(`already_linked_to_${eng.cs_ticket_no}`, 409);
  }
  const inf = eng.influencer || {};

  // POST to csops createTicket using the same bearer token
  const csopsUrl = env.CSOPS_URL || 'https://csops.afshaan.workers.dev';
  const csopsBody = {
    action: 'createTicket',
    intake_channel: 'sheet', // closest existing enum value; future: add 'ignition'
    customer_name: inf.person_name || inf.channel_name || 'Influencer',
    customer_phone: inf.contact_number || null,
    customer_email: inf.email || null,
    platform: 'website',
    external_order_id: eng.shipping_order_id || null,
    issue_description: body.issue_description,
    disposition: body.disposition || 'replacement',
  };
  if (body.issue_category) csopsBody.issue_category = body.issue_category;
  if (body.issue_subcategory) csopsBody.issue_subcategory = body.issue_subcategory;

  const r = await fetch(csopsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.bearer}`,
    },
    body: JSON.stringify(csopsBody),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok || !data?.ok) {
    return err(`csops_error: ${JSON.stringify(data)}`, r.status || 502);
  }
  const ticket_no = data.data?.ticket_no;
  if (!ticket_no) return err('csops_no_ticket_no', 502);

  // Patch the engagement
  await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ cs_ticket_no: ticket_no, updated_at: nowIso() }),
    prefer: 'return=minimal',
  });
  await writeHistory(env, body.engagement_id, 'open_pitstop_ticket', null, null,
    `Linked to Pitstop ${ticket_no}: ${body.issue_description}`, auth.userId);

  return ok({ ticket_no, engagement_no: eng.engagement_no });
}

async function createCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!body.video_count || body.video_count < 1) return err('video_count required', 400);
  // Mint a campaign_no using the same year sequence approach
  const yyyy = String(new Date().getUTCFullYear());
  const code = `CMP-${yyyy}-${String(Date.now()).slice(-6)}`;
  const r = await sb(`/rest/v1/campaigns`, env, {
    method: 'POST',
    body: JSON.stringify([{
      campaign_no: code,
      influencer_id: body.influencer_id,
      video_count: body.video_count,
      agreed_total: body.agreed_total || null,
      status: 'active',
    }]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

const CAMPAIGN_FIELDS = ['video_count', 'agreed_total', 'status'];

async function updateCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.campaign_id) return err('campaign_id required', 400);
  const patch = pickPatch(body, CAMPAIGN_FIELDS);
  if (Object.keys(patch).length === 0) return err('no_patch', 400);
  if ('status' in patch && !['active', 'completed', 'cancelled'].includes(patch.status)) {
    return err('invalid_status', 400);
  }
  const r = await sb(`/rest/v1/campaigns?id=eq.${body.campaign_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// Sweep overdue engagements and flip the offending influencers' rating to red.
// Conservative: only touches influencers currently rated 'unrated' or 'green',
// so a human-set 'yellow'/'red' (or a deliberate green) is never clobbered.
// Returns the list flagged so the dashboard can show what changed.
async function flagOverdueRatings(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const days = body.days || OVERDUE_DEFAULT_DAYS;

  const r = await sb(
    `/rest/v1/engagements?${overdueFilter(days)}&select=influencer_id,influencer:influencer_id(quality_rating)&limit=1000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);

  // Distinct influencer_ids whose current rating is auto-flippable.
  const ids = [...new Set(
    (r.data || [])
      .filter(e => ['unrated', 'green'].includes(e.influencer?.quality_rating))
      .map(e => e.influencer_id)
      .filter(Boolean),
  )];
  if (ids.length === 0) return ok({ flagged: 0, influencer_ids: [] });

  const note = `Auto-flagged red — post overdue >${Number(days) || OVERDUE_DEFAULT_DAYS}d past expected date (${nowIso().slice(0, 10)})`;
  const pr = await sb(
    `/rest/v1/influencers?id=in.(${ids.join(',')})&quality_rating=in.(unrated,green)`, env, {
    method: 'PATCH',
    body: JSON.stringify({ quality_rating: 'red', rating_notes: note, updated_at: nowIso() }),
    prefer: 'return=minimal',
  });
  if (!pr.ok) return err(`db_error: ${JSON.stringify(pr.data)}`, 400);
  return ok({ flagged: ids.length, influencer_ids: ids });
}

// Attach an engagement to a campaign (or detach when campaign_id is null/''):
// sets ignition.engagements.campaign_id. The FK guarantees the campaign exists.
async function assignEngagementToCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const campaign_id = body.campaign_id || null; // null = detach
  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ campaign_id, updated_at: nowIso() }),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

const GET_ACTIONS = {
  getInfluencers,
  getInfluencer,
  getEngagements,
  getEngagement,
  getRoster,
  getDiscountCodes,
  getCampaigns,
  getCampaign,
  getOverdueEngagements,
  getKpis,
  getReports,
  getCatalogs,
  getMe,
};

const POST_ACTIONS = {
  createInfluencer,
  updateInfluencer,
  createEngagement,
  updateEngagement,
  advanceStage,
  closeEngagement,
  setRating,
  addNote,
  addAttachment,
  assignDiscountCode,
  openPitstopTicket,
  createCampaign,
  updateCampaign,
  assignEngagementToCampaign,
  flagOverdueRatings,
};

async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.ignition_view) return err('forbidden_ignition_view', 403);

  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.ignition_view) return err('forbidden_ignition_view', 403);

  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(body, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return ok({ service: 'ignitionops', time: nowIso() });
    }

    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },
};
