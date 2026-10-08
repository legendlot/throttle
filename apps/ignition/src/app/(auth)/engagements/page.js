'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Combobox, useListNav, useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import { Segmented, StagePill, DealPill, Tile, FilterSelect, SearchField, TableCard, Row, NumCell } from '../../../components/ui/index.js';
import { STAGE_VALUES, STAGE_LABELS, STAGE_PALETTE } from '../../../lib/stages.js';
import { DEAL_TYPE_VALUES, DEAL_TYPE_LABELS } from '../../../lib/dealTypes.js';
import { productLabel, titleish, productKey } from '../../../lib/productLabel.js';
import { metricsCompleteness, organicViews } from '../../../lib/metrics.js';
import { useListScroll } from '../../../lib/useListScroll.js';

// S369 — a deal can be Complete because a metric was EXPLAINED (a recorded metric_gaps reason)
// rather than captured. The tick used to promise "all metrics captured" either way, which claims
// numbers we do not hold. Same wording as the detail pill and the manual, deliberately.
function completenessTitle(r) {
  const { viaGaps = [] } = metricsCompleteness(r);
  return viaGaps.length
    ? `Complete — ${viaGaps.join(', ')} explained, not captured`
    : 'Complete — all metrics captured';
}

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

// Completion (Afshaan, 2026-09-04) — a DERIVED flag, not a stage: `live` + all four metrics
// entered (see metricsCompleteness). "Not complete" means live-but-missing-numbers, i.e. the
// deals worth chasing — NOT every unfinished deal, which would be most of the pipeline and tell
// nobody anything. Applied client-side like every other filter below.
const COMPLETION_FILTERS = [
  { id: 'all',      label: 'All completion' },
  { id: 'complete', label: 'Complete' },
  { id: 'not',      label: 'Not complete' },
];

// The campaign filter's "not on any campaign" choice — roughly a quarter of deals, so it is a real
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
  products: [], dealType: 'all', campaign: 'all', completion: 'all',
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
  const [fetchedOnce, setFetchedOnce] = useState(false);   // the scroll restore waits for the first completed fetch
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

  const { tab, type, stages, search, products, dealType, campaign, completion, dateMode, dateFrom, dateTo } = f;

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
      .finally(() => { if (!cancelled) { setLoading(false); setFetchedOnce(true); } });

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
      if (completion !== 'all') {
        const { live, complete } = metricsCompleteness(r);
        if (completion === 'complete' && !complete) return false;
        // "Not complete" is scoped to LIVE deals only: a shipped deal has no numbers yet and
        // listing it here would bury the handful that actually need chasing.
        if (completion === 'not' && (!live || complete)) return false;
      }
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
  }, [rows, products, dealType, campaign, completion, dateMode, dateFrom, dateTo]);

  // Summary of what is on screen (Reann, 2026-08-27: "a summary tab in engagements, as it is
  // on the main dashboard, to view the total number of videos displayed and the total cost
  // when the filters are selected").
  const summary = useMemo(() => {
    let cost = 0, views = 0, paid = 0, costOfViewed = 0, viewedDeals = 0, cancelled = 0;
    for (const r of visible) {
      // Reann, 2026-08-27: a CANCELLED deal was called off before anything was spent, so its
      // money never happened and must not reach any total. DROPPED still counts — goods went
      // out and never became a video, which is a real loss. Mirrors SPEND_EXCLUDED_STAGES in
      // ignitionops; the two must agree or this tile and the Reports page quote different spend.
      if (SPEND_EXCLUDED_STAGES.has(r.stage)) { cancelled += 1; continue; }
      cost += Number(r.total_cost || 0);
      // ORGANIC views (S373): views − paid. What an ad bought is not the collab's reach, so it stays
      // out of the tile and the blended CPM — same rule as the worker's CPM and every report.
      const v = organicViews(r.views, r.paid_views) ?? 0;
      views += v;
      paid += Number(r.paid_views || 0);
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
      paid,
      cpm: views > 0 ? (costOfViewed / views) * 1000 : null,
      viewedDeals,
      cancelled,
    };
  }, [visible]);

  // Back from a deal lands where you left the list (Nandeswari, #bugs 1791356178.730839) —
  // restored once the first re-fetch has settled (rows or not), never over the spinner.
  const { ref: listRef, remember: rememberScroll } =
    useListScroll('engagements', fetchedOnce && !loading);
  function openDeal(r) { rememberScroll(); router.push(`/engagements/detail/?id=${r.id}`); }

  const { focusedIdx, setFocusedIdx } = useListNav(visible.length, (i) => {
    const r = visible[i]; if (r) openDeal(r);
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
    || products.length > 0 || dealType !== 'all' || campaign !== 'all' || completion !== 'all'
    || dateMode !== 'any';

  return (
    <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="ig-up" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)', textTransform: 'uppercase' }}>
            Work · one row per video deal
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Engagements</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* No per-tab counts: the only source would be the loaded (paged, server-filtered) set,
              which is wrong for every tab but the active one. Counts wait for a real source. */}
          <Segmented
            options={TABS.map(t => ({ value: t.id, label: t.label }))}
            value={tab}
            onChange={(id) => set({ tab: id })}
          />
          <button
            onClick={() => router.push('/engagements/new/')}
            style={{
              height: 42, padding: '0 18px', background: 'var(--text-1)', color: 'var(--bg)',
              border: 'none', borderRadius: 12, fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >+ New deal</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchField
          placeholder="Search engagement #, link, tracking, order…"
          value={search}
          onChange={e => set({ search: e.target.value })}
        />
        <FilterSelect value={type} onChange={e => set({ type: e.target.value })}>
          <option value="all">All types</option>
          <option value="video_tracking">Video</option>
          <option value="ugc">UGC</option>
        </FilterSelect>

        {/* Reann #9 — Paid / Barter. Reads `deal_type`, not `is_barter`; see DEAL_TYPE_FILTERS. */}
        <FilterSelect value={dealType} onChange={e => set({ dealType: e.target.value })}
          options={DEAL_TYPE_FILTERS.map(d => ({ value: d.id, label: d.label }))} />

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
          inputStyle={ctlInput}
        />
        {products.map(k => (
          <button key={k} type="button" onClick={() => removeProduct(k)} title="Remove this product filter" style={pickChip}>
            {productOptions.find(o => o.key === k)?.label || titleish(k)} ×
          </button>
        ))}

        {/* Reann #9 — campaign filter. campaign_id, never the DEPRECATED campaign_tag. */}
        <FilterSelect value={campaign} onChange={e => set({ campaign: e.target.value })}>
          <option value="all">All campaigns</option>
          {campaignOptions.map(o => (
            <option key={o.id} value={o.id}>{o.label} ({o.count})</option>
          ))}
        </FilterSelect>

        {/* Afshaan 2026-09-04 — completion filter; see COMPLETION_FILTERS. */}
        <FilterSelect value={completion} onChange={e => set({ completion: e.target.value })}
          options={COMPLETION_FILTERS.map(c => ({ value: c.id, label: c.label }))} />

        {/* Reann #5 — posting-date filter. */}
        <FilterSelect value={dateMode} onChange={e => set({ dateMode: e.target.value })}
          options={DATE_MODES.map(m => ({ value: m.id, label: m.label }))} />
        {dateMode === 'range' && (
          <>
            <input type="date" value={dateFrom} onChange={e => set({ dateFrom: e.target.value })} className="ig-ctl" style={dateInput} />
            <span style={{ color: 'var(--text-3)', fontSize: 13 }}>to</span>
            <input type="date" value={dateTo} onChange={e => set({ dateTo: e.target.value })} className="ig-ctl" style={dateInput} />
          </>
        )}

        {filtersActive && (
          <button onClick={clearAll} style={{
            padding: '0 8px', background: 'transparent', color: 'var(--text-3)', border: 'none',
            fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: 3,
          }}>Clear filters</button>
        )}
      </div>

      {tab === 'all' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {STAGE_VALUES.map(s => {
            const on = stages.includes(s);
            const pal = STAGE_PALETTE[s] || { fg: 'var(--text-2)', bg: 'var(--chip-neutral)' };
            return (
              <button key={s} type="button" aria-pressed={on} onClick={() => toggleStage(s)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 99,
                fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${on ? pal.fg : 'var(--border-2)'}`,
                background: on ? pal.bg : 'transparent', color: on ? pal.fg : 'var(--text-2)',
                transition: 'background 140ms, border-color 140ms, color 140ms',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: pal.fg }} />
                {STAGE_LABELS[s]}
              </button>
            );
          })}
          {stages.length > 0 && (
            <button onClick={() => set({ stages: [] })} style={{ marginLeft: 4, padding: '4px 8px', background: 'transparent', color: 'var(--text-3)', border: 'none', fontFamily: 'var(--font-ui)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>clear</button>
          )}
        </div>
      )}

      {!loading && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12,
        }}>
          <Tile
            label={filtersActive ? 'Deals (filtered)' : 'Deals'}
            value={summary.deals.toLocaleString('en-IN')}
            hint={summary.cancelled ? `incl. ${summary.cancelled} cancelled` : undefined}
          />
          <Tile
            label="Total cost"
            color="var(--accent-hi)"
            value={`₹${Math.round(summary.cost).toLocaleString('en-IN')}`}
            // Say so on the tile rather than leaving someone to wonder why the costs do not add
            // up to the deals — a total that quietly omits rows is how mistrust starts.
            hint={summary.cancelled ? `${summary.cancelled} cancelled deal${summary.cancelled === 1 ? '' : 's'} excluded` : undefined}
          />
          <Tile label="Organic views" value={summary.views.toLocaleString('en-IN')}
            hint={summary.paid ? `+ ${summary.paid.toLocaleString('en-IN')} paid (ads)` : undefined} />
          <Tile
            label="Blended CPM"
            value={summary.cpm == null ? '—' : `₹${summary.cpm.toFixed(0)}`}
            hint={summary.cpm == null ? 'no views yet' : `over ${summary.viewedDeals} deal${summary.viewedDeals === 1 ? '' : 's'} with views`}
          />
        </div>
      )}

      {loading ? <Spinner /> : (
        <TableCard columns={COLS} minWidth={1100} head={HEAD}>
          {visible.length === 0 && (
            // sticky + viewport-capped so it stays on screen inside the 1100px-wide scroll area at 375px
            <div style={{ position: 'sticky', left: 0, width: 'min(100%, calc(100vw - 24px))', padding: 48, textAlign: 'center', color: 'var(--text-4)', fontSize: 14 }}>
              {filtersActive ? 'No engagements match these filters.' : 'No engagements'}
            </div>
          )}
          {visible.map((r, i) => {
            const label = productLabel(r.product_code, r.product_variant);
            return (
              <Row key={r.id} columns={COLS} index={i} animate
                focused={focusedIdx === i}
                onClick={() => openDeal(r)}
                onMouseEnter={() => setFocusedIdx(i)}
              >
                {/* A deal with no campaign cannot be rolled up into campaign performance, so it
                    is flagged for audit (Reann item 12). Read `campaign_id` — `campaign_tag` is
                    deprecated and set on 5 rows, so flagging on it would mark almost everything.
                    ⚠️ A glyph, deliberately NOT a StageBadge-style pill: roughly a QUARTER of deals
                    carry no campaign, and a pill on that many rows is noise rather than a
                    signal. ⛔ No count is quoted here on purpose — it moves every day as deals
                    are created (113/411 → 114/413 inside one afternoon). Re-derive it. The CAMPAIGN filter already offers a
                    "No campaign" option with the live count — this is the at-a-glance companion
                    to it, in the column the eye scans first. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)', minWidth: 0 }}>
                  {r.engagement_no}
                  {!r.campaign_id && (
                    <span
                      title="No campaign — this deal is not attributed to any campaign"
                      role="img"
                      aria-label="No campaign"
                      style={{ color: 'var(--state-warning-fg)', fontSize: 12, fontWeight: 700, cursor: 'help' }}
                    >⚑</span>
                  )}
                  {/* Afshaan 2026-09-04 — Complete = live + all four metrics entered
                      (metricsCompleteness). Same glyph treatment as the ⚑ above and for the
                      same reason: this is the at-a-glance companion to the COMPLETION filter,
                      not a pill. ⛔ Nothing is rendered for an INCOMPLETE row on purpose —
                      most rows are not live, so a "missing" marker here would paint the whole
                      table; the filter is where you go looking for those. */}
                  {metricsCompleteness(r).complete && (
                    <span
                      title={completenessTitle(r)}
                      role="img"
                      aria-label={completenessTitle(r)}
                      style={{ color: 'var(--state-success-fg)', fontSize: 12, fontWeight: 700, cursor: 'help' }}
                    >✓</span>
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.influencer?.channel_name || '—'}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' }}>{r.influencer?.influencer_code}</div>
                </div>
                <div style={{ color: 'var(--text-2)' }}>{r.engagement_type === 'ugc' ? 'UGC' : 'Video'}</div>
                <div><StagePill stage={r.stage} /></div>
                <div><DealPill type={r.deal_type} /></div>
                <div style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }} title={label || undefined}>{label || '—'}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: r.post_date ? 'var(--text-4)' : 'var(--text-1)' }}>
                  {r.expected_post_date || '—'}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)' }}>{r.post_date || '—'}</div>
                <NumCell>
                  {r.views ? Number(r.views).toLocaleString('en-IN') : '—'}
                  {Number(r.paid_views) > 0 && <div style={{ fontSize: 10, color: 'var(--text-4)' }}>{Number(r.paid_views).toLocaleString('en-IN')} paid</div>}
                </NumCell>
                <NumCell color="var(--text-2)">{r.cpm ? `₹${Number(r.cpm).toFixed(0)}` : '—'}</NumCell>
                <NumCell style={{ fontWeight: 600 }}>₹{Number(r.total_cost || 0).toLocaleString('en-IN')}</NumCell>
              </Row>
            );
          })}
        </TableCard>
      )}
    </div>
  );
}

// Column grid shared by the header and every row (prototype widths). It must not start with
// "1fr 1fr": globals.css collapses any `columns: 1fr 1fr` inline grid to one column on a phone.
const COLS = '170px minmax(160px,1.4fr) 64px 130px 120px minmax(140px,1.2fr) 100px 100px 90px 70px 100px';
const HEAD = [
  'Engagement #', 'Influencer', 'Type', 'Stage', 'Deal', 'Product', 'Expected', 'Posted',
  { label: 'Views', align: 'right' }, { label: 'CPM', align: 'right' }, { label: 'Total cost', align: 'right' },
];
// Same box as FilterSelect / SearchField so the Combobox and date inputs line up in the bar.
const ctlInput = {
  height: 40, boxSizing: 'border-box', padding: '0 12px', background: 'var(--input)',
  border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', color: 'var(--text-1)',
  fontFamily: 'var(--font-ui)', fontSize: 14,
};
const dateInput = { ...ctlInput, width: 150, colorScheme: 'dark' };
const pickChip = {
  display: 'inline-flex', alignItems: 'center', padding: '5px 11px', borderRadius: 99,
  border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent-hi)',
  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
