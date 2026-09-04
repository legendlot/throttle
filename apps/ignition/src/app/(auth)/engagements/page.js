'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, Combobox, useListNav, useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../components/StageBadge.js';
import DealTypeBadge from '../../../components/DealTypeBadge.js';
import { STAGE_VALUES, STAGE_LABELS } from '../../../lib/stages.js';
import { DEAL_TYPE_VALUES, DEAL_TYPE_LABELS } from '../../../lib/dealTypes.js';
import { productLabel, titleish, productKey } from '../../../lib/productLabel.js';

// 'Live' is the terminal success stage (S214 ⑤) — the old 'Completed' tab is gone.
const TABS = [
  { id: 'all',       label: 'All',       filter: null },
  { id: 'live',      label: 'Live',      filter: 'live' },
  { id: 'scheduled', label: 'Scheduled', filter: 'scheduled' },
  { id: 'posting',   label: 'Draft rcvd', filter: 'posting' },
  { id: 'delivered', label: 'Delivered', filter: 'delivered' },
];

// Posting-date filter modes (Reann #5, 2026-08-27).
const DATE_MODES = [
  { id: 'any',      label: 'Any date' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'overdue',  label: 'Overdue' },
  { id: 'range',    label: 'Date range' },
];

// Paid / Barter (Reann #9, 2026-09-04). ⚠️ The money-shape of a deal lives in `deal_type`,
// NOT in `engagements.is_barter` — that column is NULL on all 411 rows and has never been
// written by any code path, while `deal_type` is 100% populated (311 barter / 100 paid,
// measured 2026-09-04). Built from DEAL_TYPE_VALUES rather than a hardcoded paid/barter pair
// so the two affiliate shapes the badge already renders stay reachable instead of being
// visible only under 'All'.
const DEAL_TYPE_FILTERS = [
  { id: 'all', label: 'All deal types' },
  ...DEAL_TYPE_VALUES.map(v => ({ id: v, label: DEAL_TYPE_LABELS[v] })),
];

// The campaign filter's "not on any campaign" choice — 114 of 411 deals, so it is a real
// bucket, not an edge case. 'all' and this are the only non-uuid values the filter holds.
const CAMPAIGN_NONE = '__none__';

// Stages that mean "already posted, or the deal is closed" — a deal in one of these can
// never be overdue. Mirrors the worker's POSTED_OR_TERMINAL list (ignitionops
// getOverdueEngagements); the two must agree or the Schedule page and this filter would
// disagree about who is late.
const POSTED_OR_TERMINAL = new Set(['posting', 'live', 'ghosted', 'dropped', 'cancelled', 'on_hold', 'delayed']);

// Stages whose money never happened (Reann, 2026-08-27) — mirrors SPEND_EXCLUDED_STAGES in
// ignitionops. Kept as a Set here for the same reason it is one constant there: the moment this
// list and the worker's disagree, this page and the Reports page quote different spend.
const SPEND_EXCLUDED_STAGES = new Set(['cancelled']);

// Filters survive leaving the page and coming back (Reann #2: "once a user applies filters,
// those filters should remain active … filters should only reset when the user manually
// clears or changes them"). They were being lost on every trip into a deal and back, because
// the page remounts with fresh state. Session-scoped on purpose: it should outlive a
// navigation, not a working day.
// v2 (2026-09-04): `product` (one key) became `products` (an array) and dealType/campaign
// joined. The key is bumped rather than merged so a v1 blob cannot leave `products` holding a
// string, which `.includes()` would silently treat as a substring test.
const FILTER_KEY = 'ignition.engagements.filters.v2';
const EMPTY_FILTERS = {
  tab: 'all', type: 'all', stages: [], search: '',
  products: [], dealType: 'all', campaign: 'all',
  dateMode: 'any', dateFrom: '', dateTo: '',
};

function loadFilters() {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  try {
    const raw = window.sessionStorage.getItem(FILTER_KEY);
    if (!raw) return EMPTY_FILTERS;
    const saved = JSON.parse(raw);
    // Merge over the defaults so a stored shape from an older build cannot leave a field
    // undefined and blank the control it drives.
    return {
      ...EMPTY_FILTERS, ...saved,
      stages: Array.isArray(saved.stages) ? saved.stages : [],
      products: Array.isArray(saved.products) ? saved.products : [],
    };
  } catch { return EMPTY_FILTERS; }
}

/** The date a deal is judged on: actual post date when it has one, else the expected date.
 *  Same rule as the Schedule page's `effective_date`, deliberately. */
function effectiveDate(r) {
  return r.post_date || r.expected_post_date || null;
}

function todayISO() {
  // IST — the team's day, not UTC's (a UTC date rolls over at 05:30 local and would call
  // this evening's deals "overdue" tomorrow morning by mistake).
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export default function EngagementsPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();

  const [f, setF] = useState(EMPTY_FILTERS);
  const [restored, setRestored] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [campaigns, setCampaigns] = useState([]);

  // Restore once, after mount — sessionStorage does not exist during the static export's
  // prerender, so this cannot be the useState initialiser.
  useEffect(() => { setF(loadFilters()); setRestored(true); }, []);
  useEffect(() => {
    if (!restored) return;
    try { window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* private mode */ }
  }, [f, restored]);

  function set(patch) { setF(prev => ({ ...prev, ...patch })); }
  function clearAll() { setF(EMPTY_FILTERS); }

  const { tab, type, stages, search, products, dealType, campaign, dateMode, dateFrom, dateTo } = f;

  // Campaign NAMES for the campaign filter. `getEngagements` returns `campaign_id` (the list
  // SELECT is `*`) but not the campaign's name, so the ids are unreadable on their own. Fetched
  // with NO status filter on purpose — every other caller asks for `status: 'active'` because
  // they are ASSIGNING a deal, and a filter that only offered active campaigns would make the
  // deals on a completed one unfindable. 10 campaigns today; loaded once per mount, not per
  // filter change, so it never joins the paging loop below.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    ignitionopsGet('getCampaigns', {}, session)
      .then(r => { if (!cancelled) setCampaigns(r.campaigns || []); })
      // A failed campaign fetch must not take the list down with it — the filter degrades to
      // ids-with-no-names being absent, and every other filter still works.
      .catch(() => { if (!cancelled) setCampaigns([]); });
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    if (!session || !restored) return;
    let cancelled = false;
    setLoading(true);
    const base = { type };
    const tabFilter = TABS.find(t => t.id === tab)?.filter;
    if (tabFilter) base.stage = tabFilter;
    else if (stages.length) base.stages = stages.join(',');
    if (search) base.search = search;

    // Reann, 2026-08-18: "I can only see around 95 videos, but I should have close to 200."
    // This asked for ONE page of 100 and stopped, so everything past the 100th row was
    // invisible with nothing on screen to say so — there were 233. Walk the pages until one
    // comes back short; `total` (S313) now also lets us ASSERT we got everything rather than
    // infer it from a short page, so an incomplete list reports itself instead of looking whole.
    (async () => {
      const PAGE = 200;
      const MAX_PAGES = 25;   // 5,000-row backstop against a runaway loop, not an expected ceiling
      const all = [];
      let total = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const r = await ignitionopsGet('getEngagements', { ...base, limit: PAGE, offset: p * PAGE }, session);
        if (cancelled) return;
        const batch = r.engagements || [];
        all.push(...batch);
        if (typeof r.total === 'number') total = r.total;
        if (batch.length < PAGE) break;
      }
      if (cancelled) return;
      if (total != null && all.length < total) {
        toast(`Showing ${all.length} of ${total} — the list is incomplete, please report this`, 'error');
      }
      setRows(all);
    })()
      // Paging widens the window in which the filters can change mid-flight, so every state
      // write is guarded — otherwise page 2 of the previous query lands on top of page 1 of
      // the current one and the list silently mixes two filters.
      .catch(e => { if (!cancelled) toast(e.message || 'Failed to load engagements', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [tab, type, stages, search, session, restored]);

  // Product, deal-type, campaign and posting-date filtering are all done HERE, not in the
  // worker, because the page
  // already holds the entire filtered set (it pages until a short page arrives — ~350 rows
  // today). That keeps the summary tiles below honest by construction: they count exactly the
  // rows on screen. It also means the product picker can offer the values actually in use
  // rather than the catalogue, which is what "filter by the product they are working with"
  // asks for — only 5 of 377 deal lines carry a catalogue reference (measured 2026-08-27).
  const productOptions = useMemo(() => {
    const byKey = new Map();
    for (const r of rows) {
      const k = productKey(r.product_code);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, { key: k, label: titleish(r.product_code), count: 0 });
      byKey.get(k).count += 1;
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  // Same shape and same rule as productOptions: offer only the campaigns actually carrying a
  // deal in the current set, plus the un-campaigned bucket. A campaign with zero deals is a
  // choice that can only ever empty the table.
  const campaignOptions = useMemo(() => {
    const nameById = new Map(campaigns.map(c => [c.id, c.name || c.campaign_no || '—']));
    const counts = new Map();
    let none = 0;
    for (const r of rows) {
      if (!r.campaign_id) { none += 1; continue; }
      counts.set(r.campaign_id, (counts.get(r.campaign_id) || 0) + 1);
    }
    const opts = [...counts.entries()]
      // An id with no name is a campaign the fetch above did not return (or has not loaded
      // yet). Showing the id would be unreadable, so it is labelled rather than dropped — a
      // silently missing choice is how "my deals disappeared" reports start.
      .map(([id, count]) => ({ id, label: nameById.get(id) || 'Unnamed campaign', count }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (none) opts.push({ id: CAMPAIGN_NONE, label: 'No campaign', count: none });
    return opts;
  }, [rows, campaigns]);

  const visible = useMemo(() => {
    const today = todayISO();
    // Every clause below ANDs — each one `return false`s on its own and the row must survive
    // all of them, so Barter + a campaign + two products narrows, never replaces. The
    // server-side filters (type / stage / search) have already narrowed `rows`, so these
    // compose with those too.
    return rows.filter(r => {
      if (dealType !== 'all' && r.deal_type !== dealType) return false;
      // Multi-select: empty = no constraint, otherwise the row's product must be one of the
      // picked keys (OR within the filter, AND against the others) — the standard meaning of
      // a multi-select facet.
      if (products.length && !products.includes(productKey(r.product_code))) return false;
      if (campaign === CAMPAIGN_NONE) { if (r.campaign_id) return false; }
      else if (campaign !== 'all' && r.campaign_id !== campaign) return false;
      if (dateMode === 'any') return true;
      const d = effectiveDate(r);
      if (dateMode === 'upcoming') {
        // Not yet posted, and expected on or after today.
        return !r.post_date && !!r.expected_post_date && r.expected_post_date >= today;
      }
      if (dateMode === 'overdue') {
        return !r.post_date && !!r.expected_post_date && r.expected_post_date < today
          && !POSTED_OR_TERMINAL.has(r.stage);
      }
      if (dateMode === 'range') {
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      }
      return true;
    });
  }, [rows, products, dealType, campaign, dateMode, dateFrom, dateTo]);

  // Summary of what is on screen (Reann, 2026-08-27: "a summary tab in engagements, as it is
  // on the main dashboard, to view the total number of videos displayed and the total cost
  // when the filters are selected").
  const summary = useMemo(() => {
    let cost = 0, views = 0, costOfViewed = 0, viewedDeals = 0, cancelled = 0;
    for (const r of visible) {
      // Reann, 2026-08-27: a CANCELLED deal was called off before anything was spent, so its
      // money never happened and must not reach any total. DROPPED still counts — goods went
      // out and never became a video, which is a real loss. Mirrors SPEND_EXCLUDED_STAGES in
      // ignitionops; the two must agree or this tile and the Reports page quote different spend.
      if (SPEND_EXCLUDED_STAGES.has(r.stage)) { cancelled += 1; continue; }
      cost += Number(r.total_cost || 0);
      const v = Number(r.views || 0);
      views += v;
      // Blended CPM counts only deals that actually have views. Folding in the cost of deals
      // that have not posted yet would inflate the cost-per-thousand of the ones that have.
      if (v > 0) { costOfViewed += Number(r.total_cost || 0); viewedDeals += 1; }
    }
    return {
      // The deal COUNT stays honest to the rows on screen — a cancelled deal is still a row you
      // are looking at. Only the money and metrics leave it out, and the tile says so.
      deals: visible.length,
      cost,
      views,
      cpm: views > 0 ? (costOfViewed / views) * 1000 : null,
      viewedDeals,
      cancelled,
    };
  }, [visible]);

  const { focusedIdx, setFocusedIdx } = useListNav(visible.length, (i) => {
    const r = visible[i]; if (r) router.push(`/engagements/detail/?id=${r.id}`);
  });

  function removeProduct(k) { setF(prev => ({ ...prev, products: prev.products.filter(x => x !== k) })); }
  function addProduct(k) {
    if (!k) return;
    setF(prev => (prev.products.includes(k) ? prev : { ...prev, products: [...prev.products, k] }));
  }

  function toggleStage(s) {
    setF(prev => ({
      ...prev,
      stages: prev.stages.includes(s) ? prev.stages.filter(x => x !== s) : [...prev.stages, s],
    }));
  }

  const filtersActive = tab !== 'all' || type !== 'all' || stages.length > 0 || !!search
    || products.length > 0 || dealType !== 'all' || campaign !== 'all' || dateMode !== 'any';

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Engagements
        </h1>
        <button
          onClick={() => router.push('/engagements/new/')}
          style={{
            padding: '8px 14px', background: '#FF6B00', color: '#fff',
            border: 'none', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
          }}
        >+ New Deal</button>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(t => <Chip key={t.id} active={tab === t.id} onClick={() => set({ tab: t.id })}>{t.label}</Chip>)}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          data-search-primary
          placeholder="Search engagement #, video link, tracking, order…"
          value={search}
          onChange={e => set({ search: e.target.value })}
          style={inputStyle(280)}
        />
        <select value={type} onChange={e => set({ type: e.target.value })} style={inputStyle(140)}>
          <option value="all">All types</option>
          <option value="video_tracking">Video</option>
          <option value="ugc">UGC</option>
        </select>

        {/* Reann #9 — Paid / Barter. Reads `deal_type`, not `is_barter`; see DEAL_TYPE_FILTERS. */}
        <select value={dealType} onChange={e => set({ dealType: e.target.value })} style={inputStyle(150)}>
          {DEAL_TYPE_FILTERS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>

        {/* Reann #3 (single) → #9 (multi) — product filter. Options are the products actually
            on deals. A Combobox, not a <select multiple>: every product picker in the fleet is
            a searchable Combobox (S179 / PATTERN-160). Combobox has no multi-select mode, so it
            is used as the ADD control and the picks live as removable chips beside it — the
            standard picker keeps doing the searching, and nothing is hand-rolled.
            `portal` because `.ig-main` is `overflow-y: auto`; an absolute dropdown is clipped
            by it. Selected keys are removed from the options so the list cannot re-offer them,
            and `value` is held at '' so the box empties itself ready for the next pick. */}
        <Combobox
          value=""
          options={productOptions
            .filter(o => !products.includes(o.key))
            .map(o => ({ value: o.key, label: o.label, hint: String(o.count) }))}
          onChange={(v) => addProduct(v)}
          placeholder={products.length ? 'Add product…' : 'All products'}
          allowClear={false}
          portal
          style={{ width: 190 }}
          inputStyle={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
        />
        {products.map(k => (
          <Chip key={k} active onClick={() => removeProduct(k)}>
            {productOptions.find(o => o.key === k)?.label || titleish(k)} ×
          </Chip>
        ))}

        {/* Reann #9 — campaign filter. campaign_id, never the DEPRECATED campaign_tag. */}
        <select value={campaign} onChange={e => set({ campaign: e.target.value })} style={inputStyle(190)}>
          <option value="all">All campaigns</option>
          {campaignOptions.map(o => (
            <option key={o.id} value={o.id}>{o.label} ({o.count})</option>
          ))}
        </select>

        {/* Reann #5 — posting-date filter. */}
        <select value={dateMode} onChange={e => set({ dateMode: e.target.value })} style={inputStyle(140)}>
          {DATE_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {dateMode === 'range' && (
          <>
            <input type="date" value={dateFrom} onChange={e => set({ dateFrom: e.target.value })} style={inputStyle(150)} />
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>to</span>
            <input type="date" value={dateTo} onChange={e => set({ dateTo: e.target.value })} style={inputStyle(150)} />
          </>
        )}

        {filtersActive && (
          <button onClick={clearAll} style={{
            padding: '6px 10px', background: 'transparent', color: 'var(--text-3)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
          }}>clear all filters</button>
        )}
      </div>

      {tab === 'all' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {STAGE_VALUES.map(s => (
            <Chip key={s} active={stages.includes(s)} onClick={() => toggleStage(s)}>{STAGE_LABELS[s]}</Chip>
          ))}
          {stages.length > 0 && (
            <button onClick={() => set({ stages: [] })} style={{ marginLeft: 4, padding: '4px 8px', background: 'transparent', color: 'var(--text-3)', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>clear</button>
          )}
        </div>
      )}

      {!loading && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12, marginBottom: 12,
        }}>
          <Tile
            label={filtersActive ? 'Deals (filtered)' : 'Deals'}
            value={summary.deals.toLocaleString('en-IN')}
            hint={summary.cancelled ? `incl. ${summary.cancelled} cancelled` : undefined}
          />
          <Tile
            label="Total cost"
            value={`₹${Math.round(summary.cost).toLocaleString('en-IN')}`}
            // Say so on the tile rather than leaving someone to wonder why the costs do not add
            // up to the deals — a total that quietly omits rows is how mistrust starts.
            hint={summary.cancelled ? `${summary.cancelled} cancelled deal${summary.cancelled === 1 ? '' : 's'} excluded` : undefined}
          />
          <Tile label="Views" value={summary.views.toLocaleString('en-IN')} />
          <Tile
            label="Blended CPM"
            value={summary.cpm == null ? '—' : `₹${summary.cpm.toFixed(0)}`}
            hint={summary.cpm == null ? 'no views yet' : `over ${summary.viewedDeals} deal${summary.viewedDeals === 1 ? '' : 's'} with views`}
          />
        </div>
      )}

      {loading ? <Spinner /> : (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', overflowX: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Engagement #</th>
                <th style={th}>Influencer</th>
                <th style={th}>Type</th>
                <th style={th}>Stage</th>
                <th style={th}>Deal</th>
                <th style={th}>Product</th>
                <th style={th}>Expected post</th>
                <th style={th}>Post date</th>
                <th style={thNum}>Views</th>
                <th style={thNum}>CPM</th>
                <th style={thNum}>Total cost</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={11} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No engagements</td></tr>
              )}
              {visible.map((r, i) => {
                const label = productLabel(r.product_code, r.product_variant);
                return (
                  <tr key={r.id}
                    onClick={() => router.push(`/engagements/detail/?id=${r.id}`)}
                    style={{
                      cursor: 'pointer', borderTop: '1px solid var(--border)',
                      background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                      outline: focusedIdx === i ? '2px solid #FF6B00' : 'none', outlineOffset: '-2px',
                    }}
                    onMouseEnter={() => setFocusedIdx(i)}
                  >
                    {/* A deal with no campaign cannot be rolled up into campaign performance, so it
                        is flagged for audit (Reann item 12). Read `campaign_id` — `campaign_tag` is
                        deprecated and set on 5 rows, so flagging on it would mark almost everything.
                        ⚠️ A glyph, deliberately NOT a StageBadge-style pill: 114 of 412 deals (27.7%,
                        measured 2026-09-04) carry no campaign, and a pill on more than a quarter of
                        the rows is noise rather than a signal. The CAMPAIGN filter already offers a
                        "No campaign" option with the live count — this is the at-a-glance companion
                        to it, in the column the eye scans first. */}
                    <td style={td}>
                      <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.engagement_no}</span>
                      {!r.campaign_id && (
                        <span
                          title="No campaign — this deal is not attributed to any campaign"
                          aria-label="No campaign"
                          style={{
                            marginLeft: 6, color: 'var(--state-warning-fg)',
                            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, cursor: 'help',
                          }}
                        >⚑</span>
                      )}
                    </td>
                    <td style={td}>
                      <div>{r.influencer?.channel_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.influencer?.influencer_code}</div>
                    </td>
                    <td style={td}>{r.engagement_type === 'ugc' ? 'UGC' : 'Video'}</td>
                    <td style={td}><StageBadge stage={r.stage} /></td>
                    <td style={td}><DealTypeBadge dealType={r.deal_type} /></td>
                    <td style={td}>{label || '—'}</td>
                    <td style={{ ...td, color: r.post_date ? 'var(--text-3)' : 'var(--text-1)' }}>
                      {r.expected_post_date || '—'}
                    </td>
                    <td style={td}>{r.post_date || '—'}</td>
                    <td style={tdNum}>{r.views ? Number(r.views).toLocaleString('en-IN') : '—'}</td>
                    <td style={tdNum}>{r.cpm ? `₹${Number(r.cpm).toFixed(0)}` : '—'}</td>
                    <td style={tdNum}>₹{Number(r.total_cost || 0).toLocaleString('en-IN')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '10px 12px' };
const tdNum = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' };
function inputStyle(w) {
  return {
    background: 'var(--surface-2)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
    width: w,
  };
}
