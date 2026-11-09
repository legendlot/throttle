// Builds "report" tools: one MCP tool per area of a LOT app, with a `report` enum where each report is
// exactly ONE read action on that app's worker plus a whitelist of typed parameters. Nothing else is
// ever forwarded, so a tool can only reach the read actions listed here, as the person.
import { getAs, capPayload, scrub } from '../workers.js';

const DAY = 86400000;
export const todayIST = (nowMs = Date.now()) => new Date(nowMs + 5.5 * 3600000).toISOString().slice(0, 10);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parameter types: each returns { ok, value } or { ok:false, error }. `schema` is the JSON-schema shown to Claude.
export const T = {
  date: { schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, check: v => isDate(v) ? { ok: true, value: v } : { ok: false, error: 'must be a real date, YYYY-MM-DD' } },
  uuid: { schema: { type: 'string' }, check: v => typeof v === 'string' && UUID.test(v) ? { ok: true, value: v } : { ok: false, error: 'must be an id (uuid)' } },
  uuidList: {
    schema: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    check: v => Array.isArray(v) && v.length && v.length <= 20 && v.every(x => typeof x === 'string' && UUID.test(x))
      ? { ok: true, value: v.join(',') } : { ok: false, error: 'must be a list of 1–20 ids (uuids)' },
  },
  code: { schema: { type: 'string', maxLength: 60 }, check: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,59}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'must be a plain code (letters, digits, - _ . /)' } },
  codeList: {
    schema: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 50 },
    check: v => Array.isArray(v) && v.length && v.length <= 50 && v.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,59}$/.test(x))
      ? { ok: true, value: v.join(',') } : { ok: false, error: 'must be a list of 1–50 plain codes' },
  },
  text: { schema: { type: 'string', maxLength: 80 }, check: v => typeof v === 'string' && v.length <= 80 && !/[\u0000-\u001f]/.test(v) ? { ok: true, value: v } : { ok: false, error: 'must be short plain text' } },
  bool: { schema: { type: 'boolean' }, check: v => typeof v === 'boolean' ? { ok: true, value: v ? 'true' : 'false' } : { ok: false, error: 'must be true or false' } },
  oneOf: (...vals) => ({ schema: { type: 'string', enum: vals }, check: v => vals.includes(v) ? { ok: true, value: v } : { ok: false, error: `must be one of: ${vals.join(', ')}` } }),
  int: (min, max) => ({ schema: { type: 'integer', minimum: min, maximum: max }, check: v => Number.isInteger(v) && v >= min && v <= max ? { ok: true, value: String(v) } : { ok: false, error: `must be a whole number ${min}–${max}` } }),
};

// Validates one call. Returns { ok, report, params } or { ok:false, error }.
export function parseReportArgs(reports, args, nowMs = Date.now()) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const own = (o, k) => !!o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const r = own(reports, a.report) ? reports[a.report] : null;
  if (!r) return { ok: false, error: `report must be one of: ${Object.keys(reports).join(', ')}` };
  const params = { ...(r.fixed || {}) };
  for (const k of Object.keys(a)) {
    if (k === 'report') continue;
    if (!own(r.params, k)) return { ok: false, error: `\`${k}\` is not used by the ${a.report} report${r.params && Object.keys(r.params).length ? ` (it takes: ${Object.keys(r.params).join(', ')})` : ''}` };
  }
  for (const [k, spec] of Object.entries(r.params || {})) {
    const v = a[k];
    if (v === undefined || v === null || v === '') {
      if ((r.required || []).includes(k)) return { ok: false, error: `\`${k}\` is required for the ${a.report} report` };
      continue;
    }
    const c = spec.check(v);
    if (!c.ok) return { ok: false, error: `\`${k}\` ${c.error}` };
    params[spec.as || r.rename?.[k] || k] = c.value;
  }
  // Date ranges: default today, from <= to <= today, bounded span.
  if (r.params && r.params.from && r.params.to) {
    const today = todayIST(nowMs);
    if (!params.from && params.to) params.from = r.defaultDays ? new Date(Date.parse(`${params.to}T00:00:00Z`) - (r.defaultDays - 1) * DAY).toISOString().slice(0, 10) : params.to;
    params.from = params.from || (r.defaultDays ? new Date(Date.parse(`${today}T00:00:00Z`) - (r.defaultDays - 1) * DAY).toISOString().slice(0, 10) : today);
    params.to = params.to || (a.from && !r.defaultDays ? params.from : today);
    if (params.from > params.to) return { ok: false, error: '`from` must be on or before `to`' };
    if (params.to > today) return { ok: false, error: `\`to\` cannot be after today (${today}, IST)` };
    const days = Math.round((Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / DAY) + 1;
    const max = r.maxDays || 366;
    if (days > max) return { ok: false, error: `ask for at most ${max} days at a time (this asked for ${days})` };
  }
  if (r.check) { const e = r.check(params); if (e) return { ok: false, error: e }; }
  return { ok: true, report: a.report, params: r.prep ? r.prep(params) : params };
}

// spec: { system, name, title, description, binding (env key), reports, visible?(gate), deny?(gate) }
export function reportTool(spec) {
  const props = { report: { type: 'string', enum: Object.keys(spec.reports), description: Object.entries(spec.reports).map(([k, r]) => `${k}: ${r.about}`).join(' | ') } };
  for (const r of Object.values(spec.reports)) {
    for (const [k, p] of Object.entries(r.params || {})) {
      if (!props[k]) props[k] = { ...p.schema, description: p.about || r.paramAbout?.[k] || spec.paramAbout?.[k] || '' };
    }
  }
  return {
    system: spec.system,
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Read-only. Pick a \`report\`; only the parameters that report lists are accepted. Dates are IST calendar days (YYYY-MM-DD), inclusive.`,
    inputSchema: { type: 'object', properties: props, required: ['report'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    needsSession: true,
    visible: spec.visible,
    deny: spec.deny,
    reports: spec.reports,
    parse: (args, nowMs) => { const r = parseReportArgs(spec.reports, args, nowMs); return r.ok ? { ok: true, value: { report: r.report, params: r.params } } : r; },
    run: async ({ env, sbAccess, input }) => {
      const r = spec.reports[input.report];
      const res = await getAs(env[spec.binding], sbAccess, r.action, input.params);
      if (!res.ok) return res;
      const { data, truncated } = capPayload(scrub(r.shape ? r.shape(res.data) : res.data, { emails: !!spec.scrubEmails, dropKeys: spec.dropKeys || [] }));
      return { ok: true, data: { report: input.report, params: input.params, ...(truncated.length ? { truncated } : {}), result: data } };
    },
  };
}
