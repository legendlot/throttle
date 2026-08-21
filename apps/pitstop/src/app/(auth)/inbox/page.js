'use client';
/* ════════════════════════════════════════════════════════════
   Pitstop "Volt" — Agent Inbox (S161; tabs + notes + composer S162).
   Cross-channel DM console over store.cs_wa_threads / cs_wa_messages.
   • Instagram + Facebook Messenger = two-way (reply via sendMetaMessage).
   • WhatsApp = read-only mirror (reply in BiteSpeed) until C2-B.
   • Mine / Unassigned / All assignment tabs + thread claim/assign (S162-A).
   • Private (internal) notes for agent hand-off (S162-B).
   • Composer: emoji · canned responses · note formatting (S162-C).
   • Link a thread to a ticket (IG/FB have no phone to auto-match on).
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { useListNav } from '@throttle/ui';
import { notify, notifyEnabled, setNotifyEnabled, notifyPermission, requestNotifyPermission, previewText } from '../../../lib/notify.js';
import {
  Instagram, Facebook, MessageCircle, Mail, Globe, Send, Clock, ExternalLink, Link2,
  FileText, Smile, Lock, Bold, Italic, StickyNote, UserPlus, X, Paperclip, Plus, Search,
  CheckCircle2, RotateCcw, ChevronLeft, ChevronRight, CheckSquare, XCircle, Sparkles,
  Bell, BellOff, ShoppingBag, SlidersHorizontal, Users, PlayCircle,
  AlertTriangle, Info, Monitor,
} from 'lucide-react';
import { ToneBadge, btnPrimary, btnGhost, inputStyle, selectStyle } from '../../../components/kit/index.js';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import TagPicker, { TagChip } from '../../../components/TagPicker.js';
import { ShopifyPanel } from '../../../components/ShopifyPanel.js';
import { useRefreshState } from '../layout.js';
import { fmtIstShort } from '../../../lib/datetime.js';

// Full emoji picker — lazy, client-only (keeps the emoji dataset off the main bundle).
const EmojiPicker = dynamic(() => import('../../../components/EmojiPicker.js'), {
  ssr: false,
  loading: () => <div style={{ padding: 20, fontSize: 12, color: 'var(--t3)' }}>Loading emoji…</div>,
});

// Why an inbound email attachment couldn't be stored (raw_meta.attachments[].skipped,
// stamped by csops at ingest). Shown as the chip's tooltip so a dead chip explains
// itself instead of just reading "unavailable".
const ATT_SKIP_REASON = {
  too_large: 'Too large to preview here (over 10MB) — open the email in Gmail',
  message_too_large: 'This email’s attachments exceed the size limit — open it in Gmail',
  too_many: 'Beyond the 10-attachment limit — open the email in Gmail',
  inline_part: 'Embedded in the email body, not a separate file',
  fetch_failed: 'Couldn’t be retrieved — open the email in Gmail',
  upload_failed: 'Couldn’t be saved — open the email in Gmail',
  run_budget: 'Not fetched yet — it will appear shortly',
  error: 'Couldn’t be retrieved — open the email in Gmail',
};
// Live preview of an approved WhatsApp template body (S245). Substitutes each {{pos}} with what
// the agent has typed, or a braced label while empty, so the composer shows the real message
// rather than a template name. `auto` slots (first_name, resolved from the customer profile
// server-side) always render as a label — the agent never types them.
function tplPreview(tpl, vals) {
  let s = String(tpl?.body || '');
  for (const f of (tpl?.fields || [])) {
    const typed = String(vals?.[f.token] || '').trim();
    s = s.split(`{{${f.pos}}}`).join(f.auto ? `{${f.label}}` : (typed || `{${f.label}}`));
  }
  return s;
}

// Short two-tone chime, synthesised via WebAudio (S245). Deliberately no audio asset — nothing
// to host, cache-bust or 404. Fully wrapped: browsers block audio until the page has been
// interacted with, and a blocked chime must never break a render or throw into the poll loop.
function chime() {
  try {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq, at, dur) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + dur + 0.02);
    };
    tone(880, 0, 0.12); tone(1174, 0.13, 0.16);
    setTimeout(() => { try { ctx.close(); } catch {} }, 900);
  } catch { /* autoplay blocked / no WebAudio — the tab badge still does the work */ }
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const CHANNELS = {
  instagram: { label: 'Instagram', color: '#E1306C', Glyph: Instagram, sendable: true, hasWindow: true },
  messenger: { label: 'Messenger', color: '#0084FF', Glyph: Facebook, sendable: true, hasWindow: true },
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', Glyph: MessageCircle, sendable: true, hasWindow: true },
  // Email (carecrew@, S175) — two-way via Gmail; no 24h customer window (always sendable).
  email:     { label: 'Email',     color: '#7C5CFC', Glyph: Mail, sendable: true, hasWindow: false },
  // Web (L.O.T Web widget via BiteSpeed, S182) — Chatwoot transport like WA, but no 24h window.
  web:       { label: 'Web',       color: '#F59E0B', Glyph: Globe, sendable: true, hasWindow: false },
};
const chanOf = (c) => CHANNELS[c] || { label: c || 'DM', color: 'var(--t3)', Glyph: MessageCircle, sendable: false };

// Conversation priority (S164, Pruthvi) — Urgent/High/Normal/Low, default Normal.
const PRIORITIES = {
  urgent: { label: 'Urgent', tone: 'bad' },
  high:   { label: 'High',   tone: 'warn' },
  normal: { label: 'Normal', tone: 'mute' },
  low:    { label: 'Low',    tone: 'info' },
};
const PRIORITY_OPTS = ['urgent', 'high', 'normal', 'low'];

// Operational close reasons (2026-07-28, Pruthvi). 'resolved' is deliberately NOT
// here — that is the separate Resolve action, not something you pick from a list.
// Must stay in lockstep with CONVO_CLOSE_REASONS in csops-worker/src/index.js.
const CLOSE_REASONS = [
  ['no_response',  'No response from customer'],
  ['no_evidence',  'No evidence provided'],
  ['no_payment',   'Payment not completed'],
  ['duplicate',    'Duplicate conversation'],
  ['wrong_system', 'Wrong team / system'],
  ['goodwill',     'Closed as goodwill'],
  ['no_action',    'No action needed'],
  ['other',        'Other (add a note)'],
];
const CLOSE_REASON_LABEL = Object.fromEntries(CLOSE_REASONS);
CLOSE_REASON_LABEL.resolved = 'Resolved';

// ⚠️ Meta gates every reply past the 24h window behind the SEPARATE `human_agent` App Review
// permission — it is not covered by instagram_business_manage_messages, which is what we hold.
// Until it is approved, csops sends `messaging_type:MESSAGE_TAG, tag:HUMAN_AGENT` (index.js
// ~5868) and Meta rejects it outright: IGApiException code 10, "To use 'Human Agent', your use
// of this endpoint must be reviewed and approved by Facebook" (Pruthvi 2026-08-05, screenshot).
// The 7-day machinery below is CORRECT and deliberately kept — the capability is real, the
// approval is missing. Flip this to true the day it lands and the honest copy comes back with
// it. Submit at: App Dashboard → App Review → Permissions & Features → Human Agent.
const META_HUMAN_AGENT_APPROVED = false;

// Bulk close DOES offer 'resolved' in the list. Per-thread it is a separate one-click
// button because that is the common case on a conversation you just handled; in bulk
// there is no equivalent single gesture, and leaving it out would force the honest
// outcome for a handled batch to be recorded as something else.
const BULK_CLOSE_REASONS = [['resolved', 'Resolved'], ...CLOSE_REASONS];

const shortTime = fmtIstShort;
const relTime = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
const PAGE = 60;   // conversation-list page size — "Load more" adds one PAGE at a time (S202)

// Command-bar channel order. 'all' is the unscoped segment; the rest key into CHANNELS.
const CHANNEL_KEYS = ['instagram', 'messenger', 'whatsapp', 'email', 'web'];
const SEGMENT_KEYS = ['all', ...CHANNEL_KEYS];

/* Icon-only control in the command bar / conversation header. Every caller MUST pass a
   `title` — for three of these buttons it is the only thing naming a control that used to
   be visible text. `ps-ibtn` carries hover + nothing else (see globals.css); the
   :focus-visible ring is global and deliberately not suppressed. */
const ICON_BTN = {
  display: 'grid', placeItems: 'center', width: 28, height: 28, flexShrink: 0,
  border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
  background: 'transparent', color: 'var(--t2)', cursor: 'pointer',
};
// Same shape, 26px tall — the command bar is 40px and cannot afford 28.
const BAR_BTN = { ...ICON_BTN, height: 26 };

// Tag chips shown inline in the conversation header; the remainder collapse into a `+N` that
// opens the picker. 2 rather than 3 because the header's right cluster is genuinely wide once
// an assigned agent's full name is in it (measured: 637px), and the customer's name has to win.
const TAG_CHIPS_IN_HEADER = 2;

/* ── Command-bar fit ladder (§5.13) ──────────────────────────────────────────────────────
   The bar must never wrap — losing the 40px is the whole point — so controls shed weight in
   a fixed order: 1 the active segment's text label · 2 search 200→150 · 3 Compose → icon
   only · 4 the assignment axis moves into the filters popover.

   ⚠️ Driven by the bar's OWN overflow, not by a viewport breakpoint.
   Two reasons the spec's viewport figures (1280/1200/1150/1100) cannot be used literally:
   (a) every mock is drawn with the sidebar collapsed, but PitstopSidebar is **236px expanded
       vs 64px collapsed** — a 172px swing — so a 1440px window with the sidebar OPEN leaves
       the bar ~1204px, degrades nothing, and pushes the collapse chevron off the edge; and
   (b) translating them into bar widths means budgeting the real pixel cost of ~20 controls
       whose width depends on the agent's own data (agent names, channel counts, which
       permissions they hold) — a guess that is wrong on someone's screen.
   Measuring `scrollWidth > clientWidth` asks the browser the only question that matters:
   *does it fit?* The bar cannot carry `overflow: hidden` as a backstop, because every
   popover in it is an absolutely-positioned child and would be clipped.

   Free space is read from a dedicated flexible SPACER, not from `scrollWidth`.
   ⚠️ `scrollWidth` can only report overflow, never headroom — it is never smaller than
   `clientWidth` — so a ladder that de-escalates on `clientWidth - scrollWidth` can shed a
   level and then never give it back. That matters here because the sidebar ANIMATES its
   width over 180ms: expanding it passes through narrow intermediate widths, so the bar
   would compact in passing and stay compact until a reload. The spacer sits between the
   left-hand groups and the search box (where `margin-left: auto` used to put the slack), so
   its measured width IS the room available — 0 exactly when there is none.

   Non-oscillating by construction: a level is only given back when the spacer is wider than
   restoring that level actually costs, so it can never fit at level N, un-compact to N-1,
   overflow, and compact again. `RESTORE_COST` is what each step gives back (generously);
   the +24 is margin.

   Level 0 until measured — this app is `output: 'export'`, so there is no DOM at build time
   and the first paint is never the degraded one. */
const FIT_LEVELS = 4;
const RESTORE_COST = { 1: 80, 2: 60, 3: 70, 4: 300 };
function useFitLadder(barRef, spacerRef) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const bar = barRef.current;
    const spacer = spacerRef.current;
    if (!bar || !spacer) return undefined;
    const measure = () => {
      if (bar.scrollWidth > bar.clientWidth + 1) {
        setLevel(l => Math.min(FIT_LEVELS, l + 1));                 // overflowing → shed one
      } else if (level > 0 && spacer.offsetWidth > RESTORE_COST[level] + 24) {
        setLevel(l => Math.max(0, l - 1));                          // headroom → give one back
      }
    };
    measure();                                                      // re-runs per level → converges
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [barRef, spacerRef, level]);
  return level;
}

const BITESPEED_BASE = 'https://chat.bitespeed.co';
const biteSpeedLink = (t) => (t?.provider_account_id && t?.provider_thread_ref)
  ? `${BITESPEED_BASE}/app/accounts/${t.provider_account_id}/conversations/${t.provider_thread_ref}`
  : BITESPEED_BASE;

export default function InboxPage() {
  const { session, user, perms } = useAuth();
  const { setTopbarBadge } = useRefreshState();
  const canManage = !!perms?.cs_ticket_manage;
  const canReassign = !!(perms?.cs_ticket_reassign || perms?.cs_ticket_admin);
  // Bulk resolve is admin-only (Pruthvi's own ask + the worker gate). Team leads keep bulk
  // ASSIGN; closing 200 conversations at once is the part that needs the higher bar.
  const canBulkResolve = !!perms?.cs_ticket_admin;
  const myId = user?.id || null;

  const [channel, setChannel] = useState('all');
  const [assignTab, setAssignTab] = useState('all');  // all | mine | unassigned (S162-A)
  const [stateFilter, setStateFilter] = useState('active'); // active | closed | all (S163 work-queue)
  const [ignitionScope, setIgnitionScope] = useState(false); // read-only "Transferred to Ignition" oversight view (S177, leads/admin)
  const [tagFilter, setTagFilter] = useState('');           // tag facet (S163)
  const [priorityFilter, setPriorityFilter] = useState(''); // '' | urgent|high|normal|low (S164)
  const [agentFilter, setAgentFilter] = useState('');       // '' | assigned-agent id — managers (S164)
  const [sort, setSort] = useState('recent');               // recent | oldest | priority (S164)
  // Which LOT WhatsApp number the customer wrote to (S262, Pruthvi) — lets the
  // transactional/marketing traffic be isolated and cleared without a second inbox.
  const [wabaFilter, setWabaFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');       // phone/name search box (S178, Pruthvi)
  const [search, setSearch] = useState('');                 // debounced → server query
  const [closeOpen, setCloseOpen] = useState(false);         // Close-with-reason popover (2026-07-28)
  const [closeReason, setCloseReason] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [waNumbers, setWaNumbers] = useState([]);
  const [ordersOpen, setOrdersOpen] = useState(false);
  // Command-bar filters popover — holds the four selects (sort/priority/tag/agent) that used
  // to cost two wrapped rows inside a 320px column.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Conversation-header overflow menus: Create/Link ticket, and the tag picker.
  const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [threads, setThreads] = useState([]);
  const [listLimit, setListLimit] = useState(PAGE);   // conversation-list window; "Load more" grows it (S202)
  const [stats, setStats] = useState({
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    whatsapp:  { total: 0, awaiting: null, mine: 0, unassigned: 0 },
    email:     { total: 0, awaiting: null, mine: 0, unassigned: 0 },
    web:       { total: 0, awaiting: null, mine: 0, unassigned: 0 },
  });
  const [agents, setAgents] = useState([]);
  const [canned, setCanned] = useState([]);
  const [cannedSearch, setCannedSearch] = useState('');
  const [cannedDraft, setCannedDraft] = useState(null);   // null | { title, body } (inline create)
  const [savingCanned, setSavingCanned] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [convo, setConvo] = useState(null);          // { thread, messages, linked_ticket, within_customer_window }
  // WhatsApp template send (S245). The ONLY way to speak to a customer once the 24h window has
  // closed — and every window closes when a number migrates, so this is what keeps the inbox
  // usable at the BiteSpeed cutover rather than showing the agent a dead end.
  const [tplList, setTplList]       = useState([]);
  const [tplOpen, setTplOpen]       = useState(false);
  const [tplId, setTplId]           = useState('');
  // "New conversation" (Compose) — reaching a customer who has never written to us, or whose
  // 24h window has closed. Kept as its OWN state so it can't collide with the in-thread
  // template picker, which the agent may have open on a different conversation.
  const [newOpen, setNewOpen]       = useState(false);
  const [newPhone, setNewPhone]     = useState('');
  const [newTplId, setNewTplId]     = useState('');
  const [newVals, setNewVals]       = useState({});
  const [newSending, setNewSending] = useState(false);
  const [newChannel, setNewChannel] = useState('whatsapp');   // 'whatsapp' | 'email'
  const [newEmail, setNewEmail]     = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newBody, setNewBody]       = useState('');
  const [newNote, setNewNote]       = useState(null);
  const [tplVals, setTplVals]       = useState({});
  const [tplSending, setTplSending] = useState(false);
  // Agent alerting (S245). Until the cutover the WhatsApp inbox was a mirror agents never
  // watched — they worked in BiteSpeed — so a backgrounded tab costing nothing was fine. From
  // the cutover Pitstop is the ONLY place customer messages exist, and the inbox had no active
  // signal of any kind: no tab badge, no sound, nothing. Polling alone doesn't help someone
  // looking at another tab.
  const [soundOn, setSoundOn] = useState(false);
  const [notifOn, setNotifOn] = useState(false);
  const [notifPerm, setNotifPerm] = useState('default');
  // Threads we have already raised a desktop notification for, so a 15s poll that still shows
  // the same unread thread does not re-notify every cycle. Keyed by thread id + the inbound
  // timestamp, so a NEW message on an already-notified thread does notify again.
  const notifiedRef = useRef(new Set());
  const [statsReady, setStatsReady] = useState(false);   // first successful stats load — see the chime effect
  const prevAwaitingRef = useRef(null);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('reply');          // reply | note (S162-B/C)
  // Email composer fields — To/Cc/Bcc/Subject (Pruthvi #bugs S181). Prefilled from
  // the selected email thread; Cc/Bcc hidden until the agent expands them.
  const [emailTo, setEmailTo] = useState('');
  const [emailCc, setEmailCc] = useState('');
  const [emailBcc, setEmailBcc] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkVal, setLinkVal] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showCanned, setShowCanned] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);   // [{ name, mime, size, dataUrl }] — 1 for Meta, N for email (S162-C · S201)
  const [selectedIds, setSelectedIds] = useState(() => new Set());  // bulk-select thread ids (S164)
  // Select mode gates the per-row checkboxes. They used to render on EVERY row all the
  // time, which reads as permanent visual noise on a list an agent mostly just scrolls
  // (Pruthvi #bugs 2026-07-25). Bulk-assign itself is unchanged — it's the same
  // selectedIds/bulkAssign path, just entered deliberately.
  const [selectMode, setSelectMode] = useState(false);
  const [bulkAgent, setBulkAgent] = useState('');         // target of the bulk assign action
  const [bulkReason, setBulkReason] = useState('');       // outcome for the bulk resolve action (S262)
  const [bulkNote, setBulkNote] = useState('');           // note carried with the bulk outcome (S263)
  const [bulkBusy, setBulkBusy] = useState(false);
  const scrollRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  // In-thread scrollback for the Chatwoot-pulled WA/web path (Pruthvi #bugs 2026-07-10:
  // history stopped at ~60 msgs). waPagesRef is the current page depth the poll re-pulls
  // with (so loaded-older history survives the 15s refresh); loadingOlderRef + prevHeightRef
  // preserve the scroll viewport when older messages prepend instead of jumping to bottom.
  const [oldestReached, setOldestReached] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const waPagesRef = useRef(12);
  const loadingOlderRef = useRef(false);
  const prevHeightRef = useRef(0);

  const [listCollapsed, setListCollapsed] = useState(() => {
    try { return localStorage.getItem('ps-inbox-list-collapsed') === '1'; } catch { return false; }
  });
  function toggleListCollapse() {
    setListCollapsed(v => {
      const next = !v;
      try { localStorage.setItem('ps-inbox-list-collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // List is channel-scoped (WhatsApp has thousands of threads — fetching "all"
  // would bury the low-volume IG/FB threads). Tiles get their own stats call.
  const loadThreads = useCallback(async () => {
    if (!session) return;
    try {
      const p = {};
      if (channel !== 'all') p.channel = channel;
      // Oversight scope (S177): list ONLY threads transferred to the Influencer team
      // (read-only). Bypasses the assignment/state facets — those don't apply to a full handoff.
      if (ignitionScope) {
        p.scope = 'ignition';
      } else {
        if (assignTab !== 'all') p.tab = assignTab;
        if (stateFilter !== 'active') p.state = stateFilter;   // 'active' is the worker default
      }
      if (tagFilter) p.tag = tagFilter;
      if (priorityFilter) p.priority = priorityFilter;
      if (agentFilter) p.agent = agentFilter;
      if (wabaFilter) p.waba = wabaFilter;
      if (sort !== 'recent') p.sort = sort;
      if (search) p.q = search;   // phone/name search (S178, Pruthvi) — server-side
      p.limit = listLimit;        // grows via "Load more" (S202) — single query keeps the 20s poll append-safe
      const d = await csopsGet('getMessagingThreads', p, session);
      setThreads(d?.threads || []);
      setErr(null);   // self-heal: a transient poll/auth blip must not leave a sticky banner (S177)
    } catch (e) { setErr(e.message); }
    finally { setLoadingList(false); }
  }, [session, channel, assignTab, stateFilter, tagFilter, priorityFilter, agentFilter, wabaFilter, sort, ignitionScope, search, listLimit]);

  // Reset the list window to the first page whenever a filter/channel/search changes
  // — an old expanded window must not carry into a different view. Setting PAGE when
  // it's already PAGE is a no-op (React bails), so this only refetches after Load-more.
  useEffect(() => { setListLimit(PAGE); }, [channel, assignTab, stateFilter, tagFilter, priorityFilter, agentFilter, wabaFilter, sort, ignitionScope, search]);

  // Debounce the search box → server query (S178)
  useEffect(() => { const id = setTimeout(() => setSearch(searchInput.trim()), 350); return () => clearTimeout(id); }, [searchInput]);

  const loadStats = useCallback(async () => {
    if (!session) return;
    try {
      const d = await csopsGet('getMessagingStats', {}, session);
      if (d?.stats) { setStats(d.stats); setStatsReady(true); }
    } catch { /* tiles are best-effort */ }
  }, [session]);

  const loadConvo = useCallback(async (id) => {
    if (!session || !id) return;
    try {
      const d = await csopsGet('getMessagingThread', { thread_id: id }, session);
      // WhatsApp: BiteSpeed's webhook only mirrors our outbound side, so pull the
      // live two-way conversation (+ real 24h window) from Chatwoot on demand (C2-B).
      if (d?.thread?.channel === 'whatsapp' || d?.thread?.channel === 'web') {
        try {
          const live = await csopsGet('getWaConversation', { thread_id: id, pages: waPagesRef.current }, session);
          setConvo({ ...d, messages: live.messages || [],
            within_customer_window: !!live.within_customer_window,
            window_until: live.window_until || null, wa_live: !!live.live });
          setOldestReached(live.oldest_reached !== false);
        } catch (e) {
          setConvo({ ...d, wa_live_error: e.message });   // fall back to mirrored view, flag it
          setOldestReached(true);
        }
      } else {
        setConvo(d);
        setOldestReached(true);   // DB path already returns full history (500)
      }
      setErr(null);   // self-heal on successful thread load (S177)
    } catch (e) { setErr(e.message); }
    finally { setLoadingConvo(false); }
  }, [session]);

  // Drop any bulk selection when the visible set changes (filters/tab/channel).
  useEffect(() => { setSelectedIds(new Set()); setBulkAgent(''); },
    [channel, assignTab, stateFilter, tagFilter, priorityFilter, agentFilter]);

  // Thread list — load + 20s poll. Re-fires on channel or assignment-tab change.
  useEffect(() => { setLoadingList(true); loadThreads(); }, [loadThreads]);
  useEffect(() => {
    if (!session) return undefined;
    const iv = setInterval(loadThreads, 20000);
    return () => clearInterval(iv);
  }, [session, loadThreads]);

  // Header-tile stats — load + 30s poll (independent of the active tab).
  useEffect(() => {
    if (!session) return undefined;
    loadStats();
    const iv = setInterval(loadStats, 30000);
    return () => clearInterval(iv);
  }, [session, loadStats]);

  const loadCanned = useCallback(async () => {
    if (!session) return;
    try {
      const d = await csopsGet('getCannedResponses', {}, session);
      setCanned(Array.isArray(d) ? d : (d?.data || []));
    } catch { /* picker degrades gracefully */ }
  }, [session]);

  // Agents (for assign dropdown) + canned responses — load once.
  useEffect(() => {
    if (!session) return;
    if (canManage) csopsGet('getCsAgents', {}, session).then(d => setAgents(Array.isArray(d) ? d : (d?.data || []))).catch(() => {});
    csopsGet('getTags', {}, session).then(d => setAllTags(d?.tags || [])).catch(() => {});
    // Which LOT number is which. Loaded once, never hardcoded — a phone_number_id changes on every
    // WABA migration, so a constant map would mislabel the inbox the day after one.
    csopsGet('getWaNumbers', {}, session)
      .then(d => setWaNumbers(Array.isArray(d) ? d : (d?.data || [])))
      .catch(() => {});
    loadCanned();
  }, [session, canManage, loadCanned]);

  // Open conversation — load on select + 15s poll.
  useEffect(() => {
    if (!selectedId) { setConvo(null); return undefined; }
    setLoadingConvo(true);
    waPagesRef.current = 12; loadingOlderRef.current = false; setOldestReached(true);   // reset scrollback depth per thread
    loadConvo(selectedId);
    // Mark read on OPEN (S222, Pruthvi) — team-global watermark clears the unread dot/badge
    // for everyone. Fires once per select (NOT on the 15s poll below). Optimistic local
    // clear + refresh the tile counts. Fire-and-forget.
    setThreads(prev => prev.map(t => t.id === selectedId ? { ...t, unread: false } : t));
    if (session) csopsPost('markThreadRead', { thread_id: selectedId }, session).then(() => loadStats()).catch(() => {});
    setMode('reply'); setShowEmoji(false); setShowCanned(false); setAssignOpen(false); setPendingFiles([]);
    // Header overflow menus are thread-scoped — a menu left hanging open across a thread switch
    // would be floating over a conversation the agent never opened it on.
    setTicketMenuOpen(false); setTagsOpen(false);
    const iv = setInterval(() => loadConvo(selectedId), 15000);
    return () => clearInterval(iv);
  }, [selectedId, loadConvo]);

  // ↑/↓ moves the highlight down the thread list, Enter opens the highlighted thread.
  // `/queue` and `/calls` have had this since S257; `/inbox` never did, despite that
  // session's handoff asserting it worked — it was deliberately not invented during a
  // layout-only change (PATTERN-247), so it stayed missing until 2026-08-21.
  //
  // The hook already ignores keys while an INPUT/TEXTAREA/contenteditable has focus, which
  // is what makes this safe on a screen whose main affordance is a message composer.
  const { focusedIdx, setFocusedIdx } = useListNav(
    threads.length,
    (i) => { const t = threads[i]; if (t) setSelectedId(t.id); },
  );

  // Clicking a row re-anchors the keyboard cursor, so ↓ continues from what the agent just
  // touched rather than from wherever the highlight had been left.
  //
  // ⚠️ This must fire ONCE PER SELECTION, not whenever `threads` changes. The list reloads on
  // a 20s interval and `setThreads` always installs a fresh array, so keying this on `threads`
  // alone re-ran it every poll and dragged the highlight back onto the selected row —
  // an agent arrowing down the list to read ahead would be yanked back mid-browse, twice a
  // minute, and the row would scroll under them too. The ref makes the sync edge-triggered on
  // `selectedId`; `threads` stays in the dep list only so a selection made before its row has
  // loaded still anchors once the row arrives (guarded by the `i < 0` early return, which
  // deliberately does NOT mark the id synced).
  const lastAnchoredSel = useRef(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastAnchoredSel.current) return;
    const i = threads.findIndex(t => t.id === selectedId);
    if (i < 0) return;
    lastAnchoredSel.current = selectedId;
    setFocusedIdx(i);
  }, [selectedId, threads, setFocusedIdx]);

  // Keep the highlighted row on screen — the list is a 320px scroller and arrowing past its
  // edge would otherwise move an invisible cursor.
  const focusedRowRef = useRef(null);
  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  // Scroll positioning on message change: normally pin to newest, but when older
  // history was just prepended (Load older) keep the viewport anchored on the message
  // that was at the top so the agent doesn't get thrown to the bottom.
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    if (loadingOlderRef.current) {
      el.scrollTop = el.scrollHeight - prevHeightRef.current;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [convo?.messages?.length, selectedId]);

  function loadOlderMessages() {
    if (loadingOlder || oldestReached) return;
    prevHeightRef.current = scrollRef.current?.scrollHeight || 0;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    waPagesRef.current = Math.min(waPagesRef.current + 12, 36);
    loadConvo(selectedId);
  }

  // Past-orders strip collapses again on every conversation change — an agent should open it
  // deliberately for the customer they are looking at, not inherit it from the last thread.
  useEffect(() => { setOrdersOpen(false); }, [selectedId]);

  // Prefill the email composer fields when an email thread is opened — To = the
  // customer, Subject = the thread subject (Re:-prefixed). Cleared/reset per thread.
  useEffect(() => {
    const t = convo?.thread;
    if (t?.channel !== 'email') return;
    setEmailTo(t.external_user_id || '');
    const subj = (t.subject || '').trim();
    setEmailSubject(subj ? (/^re:/i.test(subj) ? subj : `Re: ${subj}`) : '');
    setEmailCc(''); setEmailBcc(''); setShowCcBcc(false);
  }, [convo?.thread?.id, convo?.thread?.channel]);

  // "Awaiting reply" spans the two-way channels. WhatsApp joined in S245: it used to be a
  // read-only BiteSpeed mirror whose awaiting lived in BiteSpeed, but after the Relay cutover
  // inbound lands locally and it is the busiest channel of the three.
  const totalAwaiting = (stats.instagram.awaiting || 0) + (stats.messenger.awaiting || 0)
                      + (stats.whatsapp.awaiting || 0);

  // Restore the sound preference (per browser, per agent) and reset the tab title on unmount.
  useEffect(() => {
    try { setSoundOn(localStorage.getItem('pitstop_inbox_sound') === '1'); } catch {}
    // Only restore the desktop-notification toggle if the OS permission is STILL granted.
    // A previously-enabled agent whose browser permission was later revoked would otherwise see
    // the bell lit while nothing could ever fire — the toggle must reflect reality, not intent.
    try { setNotifOn(notifyEnabled() && notifyPermission() === 'granted'); } catch {}
    return () => { document.title = 'Pitstop · Customer Support'; };
  }, []);

  // Tab-title badge + chime. The BADGE is the load-bearing half — it is visible while the tab is
  // backgrounded, which is exactly when a message gets missed; polling alone cannot help someone
  // looking at a different tab.
  useEffect(() => {
    document.title = totalAwaiting > 0 ? `(${totalAwaiting}) Pitstop · Inbox` : 'Pitstop · Customer Support';
    // ⚠️ Gate on statsReady, NOT on `prev !== null`. `stats` initialises to zeros, so the pre-data
    // render already establishes prev = 0; the first real load then looks like 0 → 67 and chimes
    // for the backlog that was sitting there before the agent even opened the page. Waiting for
    // the first successful load makes the FIRST real value the baseline instead of a comparison.
    if (!statsReady) return;
    const prev = prevAwaitingRef.current;
    prevAwaitingRef.current = totalAwaiting;
    if (soundOn && prev !== null && totalAwaiting > prev) chime();
  }, [totalAwaiting, soundOn, statsReady]);

  // Desktop notification per newly-unread conversation, with the customer's name and a preview.
  //
  // ⚠️ Deliberately keyed off the THREAD LIST, not off `totalAwaiting` like the chime above.
  // A count tells you something arrived; it cannot tell you WHO from or WHAT they said, and a
  // notification reading "1 new message" is barely better than the tab badge that already
  // exists. This walks the threads and notifies per conversation.
  //
  // ⚠️ The first pass SEEDS silently instead of announcing. Same hazard the chime's `statsReady`
  // gate exists for — without it, an agent opening the page would get one notification per
  // conversation already sitting in the backlog, dozens at once — but solved differently: the
  // chime compares a count against its previous value, while this needs to know which specific
  // threads it has already spoken about, so it carries a seen-set rather than a ready flag.
  //
  // ⚠️ Scope follows whatever thread list the agent is looking at (mine / unassigned / all), which
  // is deliberately the same scope as the tab badge and the chime. An agent on the "all" tab is
  // notified about colleagues' conversations too — that is consistent with the other two alerts,
  // not an oversight. Narrow all three together or none.
  //
  // ⚠️ `tag` is what keeps this usable: three messages from one customer inside a minute REPLACE
  // each other in the OS tray rather than stacking. Ten different customers still give ten
  // notifications, which is correct — they are ten conversations.
  const notifSeededRef = useRef(false);
  useEffect(() => {
    if (!notifOn || !threads.length) return;
    const seen = notifiedRef.current;
    const unreadNow = threads.filter(t => {
      const lm = t.last_message;
      const isUnread = t.unread ?? (!!lm && lm.direction === 'inbound' && t.thread_state !== 'closed');
      return isUnread && lm && lm.direction === 'inbound';
    });
    // First pass after enabling: remember what is already there, announce nothing.
    if (!notifSeededRef.current) {
      unreadNow.forEach(t => seen.add(`${t.id}:${t.last_inbound_at || ''}`));
      notifSeededRef.current = true;
      return;
    }
    for (const t of unreadNow) {
      const key = `${t.id}:${t.last_inbound_at || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lm = t.last_message;
      const body = previewText(lm.body || (lm.kind && lm.kind !== 'text' ? `[${lm.kind}]` : ''));
      notify(displayName(t), {
        body,
        tag: `thread:${t.id}`,          // collapses repeats from one conversation
        onClick: () => setSelectedId(t.id),
      });
    }
    // Bound the set so a long shift cannot grow it without limit.
    if (seen.size > 500) notifiedRef.current = new Set([...seen].slice(-250));
  }, [threads, notifOn]);

  // Re-seed whenever the agent turns notifications on, so enabling mid-shift does not announce
  // the whole existing backlog.
  useEffect(() => { if (!notifOn) notifSeededRef.current = false; }, [notifOn]);

  // The one number agents act on moves to the topbar (the old AwaitingTile's job) — it is the
  // single figure worth 40px of chrome, and the topbar has that width spare. Published as plain
  // data, and CLEARED ON UNMOUNT so it can never linger on /queue or /calls.
  useEffect(() => {
    setTopbarBadge(totalAwaiting > 0 ? { kind: 'awaiting', n: totalAwaiting } : null);
    return () => setTopbarBadge(null);
  }, [totalAwaiting, setTopbarBadge]);
  const allTotal = useMemo(
    () => (stats.instagram.total || 0) + (stats.messenger.total || 0) + (stats.whatsapp.total || 0) + (stats.email?.total || 0) + (stats.web?.total || 0),
    [stats],
  );

  // Assignment-tab counts, scoped to the channel currently in view.
  const scoped = useMemo(() => {
    const ch = channel === 'all' ? ['instagram', 'messenger', 'whatsapp', 'email', 'web'] : [channel];
    const sum = (k) => ch.reduce((a, c) => a + (stats[c]?.[k] || 0), 0);
    return { all: sum('total'), mine: sum('mine'), unassigned: sum('unassigned') };
  }, [stats, channel]);

  // Assignment axis. `all` reads "Everyone" because the channel group directly to its left
  // already owns the word "All" — the id is untouched (it is a worker `tab` param).
  const assignTabs = [
    { id: 'mine', label: 'Mine', count: scoped.mine },
    { id: 'unassigned', label: 'Unassigned', count: scoped.unassigned },
    { id: 'all', label: 'Everyone', count: scoped.all },
  ];

  // ── composer helpers ────────────────────────────────────────
  function insertAtCaret(snippet) {
    const ta = taRef.current;
    if (!ta) { setText(t => t + snippet); return; }
    const s = ta.selectionStart ?? text.length;
    const e = ta.selectionEnd ?? text.length;
    const next = text.slice(0, s) + snippet + text.slice(e);
    setText(next);
    requestAnimationFrame(() => { ta.focus(); const p = s + snippet.length; ta.setSelectionRange(p, p); });
  }
  function wrapSelection(token) {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    if (s === e) { insertAtCaret(token + token); return; }
    const next = text.slice(0, s) + token + text.slice(s, e) + token + text.slice(e);
    setText(next);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s, e + 2 * token.length); });
  }

  // Insert a canned response. In slash mode the whole "/query" is replaced by the body;
  // otherwise it's inserted at the caret.
  function pickCanned(c) {
    if (!c) return;
    if (!noteMode && text.startsWith('/')) {
      setText(c.body);
      requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(c.body.length, c.body.length); } });
    } else {
      insertAtCaret(c.body);
    }
    setShowCanned(false); setCannedSearch('');
  }
  async function saveCanned() {
    const d = cannedDraft;
    if (!d?.title?.trim() || !d?.body?.trim() || savingCanned) return;
    setSavingCanned(true); setErr(null);
    try {
      await csopsPost('createCannedResponse', { title: d.title.trim(), body: d.body.trim() }, session);
      setCannedDraft(null);
      await loadCanned();
    } catch (e) { setErr(e.message); }
    finally { setSavingCanned(false); }
  }

  // Meta = images + PDF, single file (Graph URL-attachment path). Email = broader set
  // + multiple files, real MIME parts (S201). accept string is chosen per channel below.
  const META_ATTACH_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
  const EMAIL_ATTACH_MIMES = [...META_ATTACH_MIMES,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword', 'application/vnd.ms-excel', 'text/csv', 'text/plain', 'application/zip'];
  // Per-file cap, matched to whatever will actually accept the file downstream. A single flat
  // number here used to reject a 10MB+ catalogue before it ever reached the worker (Maria, WhatsApp
  // cutover night) while simultaneously ACCEPTING a 6MB image that WhatsApp itself caps at 5MB —
  // so the agent got the failure late and in Meta's words. Real ceilings: WhatsApp image 5MB /
  // document 20MB (our Worker-memory limit, not Meta's 100MB); Messenger+IG image 8MB; email stays
  // 10MB/file because the Gmail send path re-encodes and is capped at 15MB total server-side.
  // Mirrors ATTACH_MAX_BYTES in csops — keep the two in step.
  function attachCapFor(channel, mime) {
    if (channel === 'email') return 10 * 1024 * 1024;
    const isImage = String(mime || '').startsWith('image/');
    if (channel === 'instagram' || channel === 'messenger') return isImage ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
    return isImage ? 5 * 1024 * 1024 : 20 * 1024 * 1024;      // whatsapp / web
  }
  const capLabel = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10}MB`;

  function onPickFile(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const chNow = convo?.thread?.channel;
    const emailCh = chNow === 'email';
    const allow = emailCh ? EMAIL_ATTACH_MIMES : META_ATTACH_MIMES;
    const picked = [];
    for (const f of files) {
      if (!allow.includes(f.type)) { setErr(`Can't attach ${f.name} — unsupported file type.`); return; }
      const cap = attachCapFor(chNow, f.type);
      if (f.size > cap) {
        setErr(`${f.name} is ${capLabel(f.size)} — too large. Max ${capLabel(cap)} for ${String(f.type).startsWith('image/') ? 'images' : 'documents'} on this channel.`);
        return;
      }
      picked.push(f);
      if (!emailCh) break;   // Meta takes a single file
    }
    const readOne = (f) => new Promise(res => {
      const r = new FileReader();
      r.onload = () => res({ name: f.name, mime: f.type, size: f.size, dataUrl: r.result });
      r.readAsDataURL(f);
    });
    Promise.all(picked.map(readOne)).then(fs => {
      setPendingFiles(prev => {
        const next = emailCh ? [...prev, ...fs] : fs;
        if (emailCh && next.reduce((s, x) => s + x.size, 0) > 15 * 1024 * 1024) {
          setErr('Attachments too large — max 15MB total.'); return prev;
        }
        setErr(null); return next;
      });
    });
  }

  async function send() {
    if (sending || !convo?.thread) return;
    const t = text.trim();
    const chNow = convo.thread.channel;
    const hasFiles = pendingFiles.length > 0;
    // Meta attachment send (reply mode, single file) — caption = whatever's in the box.
    if (mode === 'reply' && hasFiles && (chNow === 'instagram' || chNow === 'messenger')) {
      setSending(true); setErr(null);
      const f = pendingFiles[0];
      try {
        await csopsPost('sendMetaAttachment', {
          thread_id: convo.thread.id, mime_type: f.mime,
          data_base64: f.dataUrl, filename: f.name, caption: t || null,
        }, session);
        setText(''); setPendingFiles([]); setShowEmoji(false); setShowCanned(false);
        await loadConvo(selectedId); loadThreads(); loadStats();
      } catch (e) { setErr(e.message); }
      finally { setSending(false); }
      return;
    }
    // WhatsApp / Web attachment send (reply mode, single file, via Chatwoot multipart).
    if (mode === 'reply' && hasFiles && (chNow === 'whatsapp' || chNow === 'web')) {
      setSending(true); setErr(null);
      const f = pendingFiles[0];
      try {
        await csopsPost('sendWaAttachment', {
          thread_id: convo.thread.id, mime_type: f.mime,
          data_base64: f.dataUrl, filename: f.name, caption: t || null,
        }, session);
        setText(''); setPendingFiles([]); setShowEmoji(false); setShowCanned(false);
        await loadConvo(selectedId); loadThreads(); loadStats();
      } catch (e) { setErr(e.message); }
      finally { setSending(false); }
      return;
    }
    // Attachments outside email/Meta/WA/Web reply mode aren't supported.
    if (mode === 'reply' && hasFiles && chNow !== 'email') {
      setErr('Attachments are only supported on Email, Instagram, Messenger, WhatsApp and Web.'); return;
    }
    // Email may send attachments with no body text; every other path needs text.
    if (!t && !(mode === 'reply' && chNow === 'email' && hasFiles)) return;
    setSending(true); setErr(null);
    try {
      if (mode === 'note') {
        await csopsPost('addThreadNote', { thread_id: convo.thread.id, text: t }, session);
      } else if (chNow === 'whatsapp' || chNow === 'web') {
        await csopsPost('sendWaReply', { thread_id: convo.thread.id, text: t }, session);   // C2-B BiteSpeed tunnel (WA + Web)
      } else if (chNow === 'email') {
        if (!emailTo.trim()) { setErr('Add at least one To recipient.'); setSending(false); return; }
        await csopsPost('sendEmailReply', {
          thread_id: convo.thread.id, text: t,
          to: emailTo, cc: emailCc || undefined, bcc: emailBcc || undefined,
          subject: emailSubject || undefined,
          // Real MIME attachment parts on the Gmail send (S201).
          attachments: hasFiles ? pendingFiles.map(f => ({ mime_type: f.mime, data_base64: f.dataUrl, filename: f.name })) : undefined,
        }, session); // Gmail-native, in-thread (S175); To/Cc/Bcc/Subject S181; attachments S201
      } else {
        await csopsPost('sendMetaMessage', { thread_id: convo.thread.id, text: t }, session);
      }
      setText(''); setPendingFiles([]); setShowEmoji(false); setShowCanned(false);
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setSending(false); }
  }

  // Lazy-load on first open: the list is tiny and static, and fetching it for every thread the
  // agent merely clicks through would be pure noise.
  async function openTemplates() {
    setErr(null);
    setTplOpen(true);
    if (tplList.length || !session) return;
    try {
      const r = await csopsGet('getWaSendTemplates', {}, session);
      setTplList(Array.isArray(r) ? r : []);
    } catch (e) { setErr(e.message); }
  }

  async function sendTemplate() {
    if (!convo?.thread || !tplId) return;
    setTplSending(true); setErr(null);
    try {
      await csopsPost('sendWaTemplateReply', {
        thread_id: convo.thread.id, template_id: tplId, variables: tplVals,
      }, session);
      setTplOpen(false); setTplId(''); setTplVals({});
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setTplSending(false); }
  }

  // Open a brand-new WhatsApp conversation. The worker decides whether a template is actually
  // needed: if the customer already has an open 24h window it returns window_open and sends
  // NOTHING, because a free session message is the right tool there and burning a template
  // would read oddly mid-conversation.
  function resetCompose() {
    setNewPhone(''); setNewTplId(''); setNewVals({});
    setNewEmail(''); setNewSubject(''); setNewBody('');
  }

  async function startConversation() {
    if (newChannel === 'whatsapp' ? !newPhone.trim() : !newEmail.trim()) return;
    setNewSending(true); setErr(null); setNewNote(null);
    try {
      const r = newChannel === 'email'
        ? await csopsPost('startEmailConversation', {
            to: newEmail.trim(), subject: newSubject.trim(), text: newBody,
          }, session)
        : await csopsPost('startWaConversation', {
            phone: newPhone.trim(),
            template_id: newTplId || undefined,
            variables: newVals,
          }, session);
      if (r?.window_open) {
        // Not an error — the conversation exists and is live. Take the agent straight to it.
        // ⚠️ Bound to the thread it is ABOUT, not left floating. The banner renders in the
        // conversation pane, and nothing clears it on a thread switch — unbound, a note about
        // this customer would keep showing while the agent read a different conversation.
        // `thread_id` is absent only when the worker found an open window but returned no
        // thread to jump to; there is no navigation in that case, so the note stays on
        // whatever is open (threadId null renders anywhere) rather than being dropped.
        setNewNote({ threadId: r.thread_id || null,
                     text: r.message || 'That customer already has an open window — opening the conversation.' });
        setNewOpen(false); resetCompose();
        if (r.thread_id) { setSelectedId(r.thread_id); await loadConvo(r.thread_id); }
        loadThreads();
        return;
      }
      setNewOpen(false); resetCompose();
      if (r?.thread_id) { setSelectedId(r.thread_id); await loadConvo(r.thread_id); }
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setNewSending(false); }
  }

  async function assign(agentId) {
    if (!convo?.thread) return;
    setErr(null); setAssignOpen(false);
    try {
      await csopsPost('assignThread', { thread_id: convo.thread.id, agent_id: agentId }, session);
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
  }

  // Transfer to another agent + optional handoff note (Pruthvi's request).
  async function transfer(agentId, note) {
    if (!convo?.thread || !agentId) return;
    setErr(null); setAssignOpen(false);
    try {
      await csopsPost('transferThread', { thread_id: convo.thread.id, to_agent_id: agentId, note: note || null }, session);
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
  }

  // Full handoff to the Influencer team (Ignition) — S177. Once transferred the
  // thread leaves the CS active inbox (the worker excludes it). Optional handoff note.
  async function transferToIgnition(note) {
    if (!convo?.thread) return;
    setErr(null); setAssignOpen(false);
    try {
      await csopsPost('transferThreadToIgnition', { thread_id: convo.thread.id, note: note || null }, session);
      // It's gone from the normal inbox now — drop the selection + refresh the list.
      setSelectedId(null); setConvo(null);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
  }

  // ── bulk multi-select (S164, Pruthvi) ───────────────────────
  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    const visible = threads.map(t => t.id);
    const allSel = visible.length > 0 && visible.every(id => selectedIds.has(id));
    setSelectedIds(allSel ? new Set() : new Set(visible));
  }
  // Single exit point: leaving select mode must never strand a selection behind hidden
  // checkboxes (an invisible selection that a later bulk assign would still act on).
  function exitSelectMode() {
    setSelectedIds(new Set());
    setBulkAgent('');
    setBulkReason('');
    setBulkNote('');
    setSelectMode(false);
  }
  async function bulkAssign() {
    if (selectedIds.size === 0 || !bulkAgent) return;
    setErr(null); setBulkBusy(true);
    const agent_id = bulkAgent === '__release__' ? null : bulkAgent;
    try {
      await csopsPost('bulkAssignThreads', { thread_ids: [...selectedIds], agent_id }, session);
      exitSelectMode();
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setBulkBusy(false); }
  }

  // 'Other' is labelled "(add a note)", so in bulk it must actually take one — the S262
  // build offered the option with nowhere to type, which reads as the app refusing to
  // resolve (Pruthvi 2026-08-04). Every other outcome names itself; the note stays optional
  // there, matching the per-thread Close popover.
  const bulkNoteMissing = bulkReason === 'other' && !bulkNote.trim();

  // Bulk resolve (Pruthvi 2026-07-31). Deliberately confirms first: bulk assign is trivially
  // undoable by assigning again, whereas this writes a closing outcome onto up to 200
  // conversations, and reopening them individually is exactly the tedium being removed.
  async function bulkResolve() {
    if (selectedIds.size === 0 || !bulkReason || bulkNoteMissing) return;
    const label = CLOSE_REASON_LABEL[bulkReason] || bulkReason;
    if (!window.confirm(`Resolve ${selectedIds.size} conversation${selectedIds.size === 1 ? '' : 's'} as "${label}"?`)) return;
    setErr(null); setBulkBusy(true);
    try {
      await csopsPost('bulkSetThreadState',
        { thread_ids: [...selectedIds], state: 'closed', closed_reason: bulkReason,
          closed_note: bulkNote.trim() || null }, session);
      exitSelectMode();
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setBulkBusy(false); }
  }

  // Work-queue toggle (S163), split into Resolve vs Close 2026-07-28 (Pruthvi).
  // Resolve = the issue was actually addressed. Close = shut for an operational
  // reason, which must be picked. Reopen clears whichever it was.
  async function setThreadStateAction(state, closed_reason = null, closed_note = null) {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('setThreadState',
        { thread_id: convo.thread.id, state, closed_reason, closed_note }, session);
      setCloseOpen(false); setCloseReason(''); setCloseNote('');
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
  }

  // "Not a collab" — sticky dismissal so a support thread that keeps saying
  // "charges" is only ever flagged once.
  async function dismissCollab() {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('dismissCollabFlag', { thread_id: convo.thread.id }, session);
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
  }

  // Set the conversation's priority (S164, Pruthvi).
  async function setPriorityAction(priority) {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('setThreadPriority', { thread_id: convo.thread.id, priority }, session);
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
  }

  // Quick-create a ticket from this conversation + auto-link it (S164, Pruthvi).
  async function createTicketFromConvo() {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('createTicketFromThread', { thread_id: convo.thread.id }, session);
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
  }

  // Replace-set the conversation's tags (S163).
  async function setThreadTagsAction(tagIds) {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('setThreadTags', { thread_id: convo.thread.id, tag_ids: tagIds }, session);
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
  }

  async function linkTicket() {
    const tn = linkVal.trim();
    if (!tn || !convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('linkMessagingThread', { thread_id: convo.thread.id, ticket_no: tn }, session);
      setLinkOpen(false); setLinkVal('');
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
  }

  const thread = convo?.thread;
  const ch = thread ? chanOf(thread.channel) : null;
  const threadTags = convo?.tags || [];
  // Past-orders lookup key. NB there is no `customer_email` on a thread — an email thread
  // carries the address in `external_user_id`, so the key is channel-dependent.
  const ordersPhone = thread?.customer_phone || '';
  const ordersEmail = thread?.channel === 'email' ? (thread?.external_user_id || '') : '';
  const hasOrdersKey = !!(ordersPhone || ordersEmail);
  // Which of OUR numbers this thread is on. Null on non-WhatsApp threads, on legacy threads that
  // predate per-number attribution, and until getWaNumbers resolves — the chip simply does not
  // render, rather than guessing a number and being confidently wrong about who we are speaking as.
  const waLabel = (thread?.channel === 'whatsapp' && thread?.waba_phone_number_id)
    ? (waNumbers.find(n => n.phone_number_id === String(thread.waba_phone_number_id))?.label || null)
    : null;
  // Transferred to the Influencer team (Ignition) — full handoff (S177). CS keeps a
  // read-only oversight view: no reply/compose, no re-transfer. The flag rides on the
  // thread object when present; the oversight scope view is read-only regardless.
  const isIgnitionThread = !!thread?.ignition_connect;
  const readOnlyView = ignitionScope || isIgnitionThread;
  const hasWindow = !!ch?.hasWindow;                 // email has no 24h window — always sendable
  const windowOpen = !hasWindow || !!convo?.within_customer_window;
  const mineThread = thread && thread.assigned_agent_id && thread.assigned_agent_id === myId;
  const noteMode = mode === 'note';
  // WhatsApp (C2-B) replies tunnel through BiteSpeed: free-text + media, only inside
  // the 24h customer window (worker enforces; template send is a fast-follow). Media
  // now supported via Chatwoot multipart (sendWaAttachment).
  const isWa = thread?.channel === 'whatsapp';
  const isEmail = thread?.channel === 'email';
  const waReplyBlocked = isWa && !noteMode && !windowOpen;
  // Meta's human-agent allowance: on Instagram/Messenger a reply still sends for 7 DAYS after
  // the customer's last message, which is what sendMetaMessage already does (MESSAGE_TAG +
  // HUMAN_AGENT). WhatsApp has no equivalent — there, past 24h is a real wall. Measured from
  // last_inbound_at, NOT from customer_window_until: that column is stamped +24h on every
  // channel, so deriving 7 days from it would silently be 6 days short.
  const META_AGENT_DAYS = 7;
  const metaLastInbound = (!isWa && hasWindow && thread?.last_inbound_at)
    ? Date.parse(thread.last_inbound_at) : null;
  const metaDaysLeft = metaLastInbound
    ? Math.max(0, Math.ceil((metaLastInbound + META_AGENT_DAYS * 86400000 - Date.now()) / 86400000))
    : null;
  // Unknown last-inbound is treated as still-sendable: the worker will try the send either
  // way, and telling an agent it is shut when it is not is the exact failure being fixed.
  const metaStillSends = !isWa && hasWindow && !windowOpen && (metaDaysLeft == null || metaDaysLeft > 0);
  const tplSel = tplList.find((t) => t.id === tplId) || null;
  const canAttach = ['instagram', 'messenger', 'email', 'whatsapp', 'web'].includes(thread?.channel);   // IG/FB = Graph URL; email = MIME parts (S201); WA/Web = Chatwoot multipart
  const attachAccept = isEmail
    ? 'image/png,image/jpeg,image/webp,image/gif,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.ms-excel,text/csv,text/plain,application/zip'
    : 'image/png,image/jpeg,image/webp,image/gif,application/pdf';
  const slashActive = !noteMode && text.startsWith('/');           // "/" quick-access to canned
  const cannedQuery = (slashActive ? text.slice(1) : cannedSearch).trim().toLowerCase();
  const filteredCanned = cannedQuery
    ? canned.filter(c => `${c.title} ${c.body}`.toLowerCase().includes(cannedQuery))
    : canned;

  const miniSelect = { flex: 1, minWidth: 92, fontSize: 11, padding: '4px 6px',
    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--t1)', cursor: 'pointer' };

  // Filters popover carries an "off default" dot so a hidden filter is never silently applied.
  const filtersDirty = sort !== 'recent' || !!priorityFilter || !!tagFilter || !!agentFilter || !!wabaFilter;
  function clearFilters() { setSort('recent'); setPriorityFilter(''); setTagFilter(''); setAgentFilter(''); setWabaFilter(''); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <InboxCommandBar
        channel={channel} setChannel={setChannel} stats={stats} allTotal={allTotal}
        assignTabs={assignTabs} assignTab={assignTab} setAssignTab={setAssignTab}
        stateFilter={stateFilter} setStateFilter={setStateFilter}
        ignitionScope={ignitionScope}
        onToggleIgnition={() => { setIgnitionScope(v => !v); setSelectedId(null); }}
        soundOn={soundOn}
        onToggleSound={() => { const v = !soundOn; setSoundOn(v); try { localStorage.setItem('pitstop_inbox_sound', v ? '1' : '0'); } catch {} if (v) chime(); }}
        notifOn={notifOn}
        notifPermission={notifPerm}
        onToggleNotif={async () => {
          if (notifOn) { setNotifOn(false); setNotifyEnabled(false); return; }
          // Turning ON: ask for permission from inside this click. Browsers ignore (and Chrome
          // can permanently block) a request made outside a user gesture, so this must stay here.
          const perm = await requestNotifyPermission();
          setNotifPerm(perm);
          if (perm === 'granted') { setNotifOn(true); setNotifyEnabled(true); }
          else { setNotifOn(false); setNotifyEnabled(false); setErr(
            perm === 'denied'
              ? 'Desktop notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
              : 'Desktop notifications are not available in this browser.'); }
        }}
        searchInput={searchInput} setSearchInput={setSearchInput}
        sort={sort} setSort={setSort}
        priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter}
        tagFilter={tagFilter} setTagFilter={setTagFilter}
        agentFilter={agentFilter} setAgentFilter={setAgentFilter}
        wabaFilter={wabaFilter} setWabaFilter={setWabaFilter} waNumbers={waNumbers}
        allTags={allTags} agents={agents}
        filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen}
        filtersDirty={filtersDirty} clearFilters={clearFilters} miniSelect={miniSelect}
        canManage={canManage} canReassign={canReassign}
        selectMode={selectMode}
        onToggleSelect={() => { if (selectMode) exitSelectMode(); else setSelectMode(true); }}
        onCompose={() => { setNewOpen(true); setNewNote(null); openTemplates(); }}
        listCollapsed={listCollapsed} toggleListCollapse={toggleListCollapse}
      />

      {/* Bulk multi-select + assign (S164, Pruthvi) — a full-width band directly under the bar
          rather than a row inside the 320px column. Entering select mode is the bar's job now;
          this band is what you do once you are in it. */}
      {selectMode && threads.length > 0 && (() => {
        const visible = threads.map(t => t.id);
        const allSel = visible.every(id => selectedIds.has(id));
        const someSel = visible.some(id => selectedIds.has(id));
        return (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, minHeight: 32,
            padding: '0 16px', background: 'var(--accent-bg)', borderBottom: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={allSel}
                ref={el => { if (el) el.indeterminate = someSel && !allSel; }}
                onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
            </label>
            {selectedIds.size === 0 ? (
              <button onClick={exitSelectMode}
                style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer' }}>
                Cancel
              </button>
            ) : (
              <>
                <select value={bulkAgent} onChange={e => setBulkAgent(e.target.value)} title="Assign selected to…"
                  style={{ ...miniSelect, flex: '0 0 auto', minWidth: 150 }}>
                  <option value="">Assign to…</option>
                  {myId && <option value={myId}>Me</option>}
                  {canReassign && agents.filter(a => a.id !== myId).map(a => (
                    <option key={a.id} value={a.id}>{a.full_name || a.email}</option>
                  ))}
                  {canReassign && <option value="__release__">Release (unassign)</option>}
                </select>
                <button onClick={bulkAssign} disabled={!bulkAgent || bulkBusy}
                  style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--accent)', background: 'var(--accent)', color: '#000',
                    cursor: (!bulkAgent || bulkBusy) ? 'default' : 'pointer', opacity: (!bulkAgent || bulkBusy) ? 0.5 : 1 }}>
                  {bulkBusy ? '…' : 'Apply'}
                </button>
                {/* Bulk resolve (Pruthvi 2026-07-31), admin-only — the worker gates it too.
                    An outcome is still required; picking one here replaces N modals, it does
                    not skip the record. */}
                {canBulkResolve && (
                  <>
                    <span style={{ width: 1, alignSelf: 'stretch', margin: '6px 2px', background: 'var(--border)' }} />
                    <select value={bulkReason} onChange={e => setBulkReason(e.target.value)} title="Resolve selected as…"
                      style={{ ...miniSelect, flex: '0 0 auto', minWidth: 150 }}>
                      <option value="">Resolve as…</option>
                      {BULK_CLOSE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {bulkReason && (
                      <input value={bulkNote} onChange={e => setBulkNote(e.target.value)} maxLength={300}
                        placeholder={bulkReason === 'other' ? 'Note (required)' : 'Note (optional)'}
                        title="Saved on every conversation in this batch"
                        style={{ fontSize: 11, padding: '4px 8px', flex: '1 1 160px', minWidth: 120, maxWidth: 320,
                          borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', color: 'var(--t1)',
                          border: `1px solid ${bulkNoteMissing ? 'var(--bad-bd)' : 'var(--border)'}` }} />
                    )}
                    <button onClick={bulkResolve} disabled={!bulkReason || bulkNoteMissing || bulkBusy}
                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--ok-bd)', background: 'var(--ok-bg)', color: 'var(--ok-fg)',
                        cursor: (!bulkReason || bulkNoteMissing || bulkBusy) ? 'default' : 'pointer',
                        opacity: (!bulkReason || bulkNoteMissing || bulkBusy) ? 0.5 : 1 }}>
                      {bulkBusy ? '…' : `Resolve ${selectedIds.size}`}
                    </button>
                  </>
                )}
                <button onClick={exitSelectMode}
                  style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer' }}>
                  Clear
                </button>
              </>
            )}
          </div>
        );
      })()}

      {err && (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--bad-fg)', background: 'var(--bad-bg)',
          borderBottom: '1px solid var(--bad-bd)', padding: '8px 16px' }}>{err}</div>
      )}

      {/* Two-pane via grid: list shrinks 320→200, conversation holds a 340px floor so
          it never collapses to a sliver in narrow/zoomed desktop windows (was a fixed
          340 list + flex chat that could squeeze the chat to ~0). Edge to edge — no gap,
          no radius, no outer border; a single 1px divider carries the split. */}
      <div style={{ display: 'grid', gridTemplateColumns: listCollapsed ? '28px minmax(340px, 1fr)' : 'minmax(200px, 320px) minmax(340px, 1fr)',
        gap: 0, flex: 1, minHeight: 0 }}>
        {/* ── Thread list ───────────────────────────────────────────────────────────────
            Every band that used to sit above the first row (panel header · assignment axis ·
            filter selects · search · select) now lives in the command bar. What is left IS
            the list — which is the entire point of the change. */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
          {!listCollapsed && (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingList ? (
              <Empty>Loading…</Empty>
            ) : threads.length === 0 ? (
              <Empty>{assignTab === 'unassigned' ? 'No unassigned conversations.' : assignTab === 'mine' ? 'Nothing assigned to you.' : 'No conversations yet.'}</Empty>
            ) : threads.map((t, i) => {
              const checked = selectedIds.has(t.id);
              // The keyboard cursor is drawn as an inset left rail rather than a background,
              // because `checked` and `active` already own the row's background — three
              // competing fills would make none of them legible.
              const kbFocused = i === focusedIdx && t.id !== selectedId;
              return (
                <div key={t.id}
                  ref={i === focusedIdx ? focusedRowRef : null}
                  style={{ display: 'flex', alignItems: 'stretch',
                    borderBottom: '1px solid var(--border)',
                    boxShadow: kbFocused ? 'inset 3px 0 0 var(--accent)' : undefined,
                    background: checked ? 'var(--accent-bg)' : 'transparent' }}>
                  {selectMode && (
                    <label onClick={e => e.stopPropagation()}
                      style={{ display: 'flex', alignItems: 'center', padding: '0 4px 0 10px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleSelect(t.id)} style={{ cursor: 'pointer' }} />
                    </label>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ThreadRow t={t} active={t.id === selectedId} myId={myId} onClick={() => setSelectedId(t.id)} noBorder />
                  </div>
                </div>
              );
            })}
            {/* Load more — shown when the window came back full, so older conversations
                may exist beyond it (S202). Grows the single-query window by one PAGE. */}
            {!loadingList && threads.length >= listLimit && (
              <button onClick={() => setListLimit(n => n + PAGE)}
                style={{ width: '100%', padding: '10px 12px', border: 'none', borderTop: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Load older conversations
              </button>
            )}
          </div>
          )}
        </div>

        {/* ── Conversation ──────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', overflow: 'hidden' }}>
          {!thread ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--t3)', fontSize: 13 }}>
              Select a conversation to view it.
            </div>
          ) : (
            <>
              {/* Header — ONE row, no wrap. The pane's three persistent bands (header + tags +
                  Past orders) are folded into this single 48px row; nothing was dropped, three
                  controls moved behind titled icon buttons. */}
              <div style={{ padding: '8px 16px', minHeight: 48, flexShrink: 0,
                borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar t={thread} size={30} />
                {/* Identity — channel glyph · name · number · which-of-our-numbers · email
                    address + subject, all on the one line. The command bar's active segment
                    already names the channel, so the glyph carries it here (label in `title`). */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span title={ch.label} style={{ display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <ch.Glyph size={13} style={{ color: ch.color }} />
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis' }} title={displayName(thread)}>{displayName(thread)}</span>
                  {/* The customer's number, ALONGSIDE the name rather than instead of it.
                      displayName() falls back to the phone, so the moment WhatsApp names
                      started resolving the number vanished from the header — and an agent
                      who needs to CALL the customer had nowhere to read it (Pruthvi). */}
                  {thread.customer_phone && thread.customer_handle
                    && thread.customer_handle !== thread.customer_phone && (
                    <span style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--t3)',
                      whiteSpace: 'nowrap', flexShrink: 0 }} title="Customer's number">{thread.customer_phone}</span>
                  )}
                  {/* WHICH OF OUR NUMBERS this conversation is on. Support, marketing and
                      transactional read completely differently to a customer, so an agent
                      replying needs to know which one they are speaking as. */}
                  {waLabel && (
                    <span style={{ fontSize: 10.5, color: 'var(--t3)', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px',
                      whiteSpace: 'nowrap', flexShrink: 0 }}
                      title={`This conversation is on our ${waLabel} number`}>to {waLabel}</span>
                  )}
                  {thread.channel === 'email' && thread.external_user_id && (
                    <span style={{ fontSize: 11, color: 'var(--t4)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }} title={thread.external_user_id}>
                      {thread.external_user_id}</span>
                  )}
                  {/* Subject stays readable here AND stays editable in the composer's Subject field. */}
                  {thread.channel === 'email' && thread.subject && (
                    <span style={{ fontSize: 11.5, color: 'var(--t2)', fontWeight: 500, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }} title={thread.subject}>
                      {thread.subject}</span>
                  )}
                </div>

                {/* Tags — was a 32px band of its own. A couple of chips inline with one-click
                    remove; the rest, plus add/create, behind the picker so the row cannot wrap.
                    ⚠️ Both the chips' remove AND the picker operate on the FULL `threadTags` list —
                    handing TagPicker a truncated `value` would make its next save DELETE the
                    tags it could not see.
                    ⚠️ The chip strip is BOUNDED and shrinkable, and the `+N`/`+` buttons sit
                    OUTSIDE it. Tags are secondary here (they also show on every list row) but as
                    an unbounded flex-shrink:0 sibling they beat the customer's NAME, which is the
                    one thing that must stay readable: measured live at 1128px of header, tags took
                    333px and the name collapsed to 61px ("ft.za…"). Bounding the strip — rather
                    than flooring the name with a min-width — avoids leaving dead space beside a
                    short name. */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
                    maxWidth: 220, overflow: 'hidden' }}>
                    {threadTags.slice(0, TAG_CHIPS_IN_HEADER).map(tag => (
                      <span key={tag.id} style={{ flexShrink: 0, display: 'inline-flex' }}>
                        <TagChip tag={tag} small
                          onRemove={canManage ? (t) => setThreadTagsAction(threadTags.filter(x => x.id !== t.id).map(x => x.id)) : null} />
                      </span>
                    ))}
                  </div>
                  {threadTags.length > TAG_CHIPS_IN_HEADER && (
                    <button onClick={() => setTagsOpen(v => !v)}
                      title={`Also tagged: ${threadTags.slice(TAG_CHIPS_IN_HEADER).map(t => t.name).join(', ')}`}
                      style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                        border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--t3)',
                        cursor: 'pointer', flexShrink: 0 }}>
                      +{threadTags.length - TAG_CHIPS_IN_HEADER}
                    </button>
                  )}
                  {canManage && (
                    <button className="ps-ibtn" onClick={() => setTagsOpen(v => !v)} title="Add or remove tags"
                      style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: 999,
                        border: '1px dashed var(--border-2)', background: 'transparent', color: 'var(--t3)',
                        cursor: 'pointer', flexShrink: 0 }}>
                      <Plus size={10} />
                    </button>
                  )}
                  {tagsOpen && (
                    <Popover onClose={() => setTagsOpen(false)} width={250} placement="down" scroll={false}>
                      <div className="label" style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)',
                        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, paddingRight: 16 }}>Tags</div>
                      <TagPicker session={session} value={threadTags} onSave={setThreadTagsAction}
                        canManage={canManage} canCreate={canManage} small />
                    </Popover>
                  )}
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {ch.hasWindow && <WindowPill open={windowOpen} until={thread.customer_window_until} agentDaysLeft={metaStillSends ? metaDaysLeft : null} />}
                  {/* Claim stays ONE click — it is the most-used control on this row. */}
                  {canManage && !isIgnitionThread && (
                    <AssignBadge thread={thread} mineThread={mineThread} myId={myId} onAssign={assign} />
                  )}
                  {isIgnitionThread && (
                    <ToneBadge tone="info"><ExternalLink size={10} style={{ marginRight: 3 }} /> Influencer team</ToneBadge>
                  )}
                  {/* Priority (S164, Pruthvi) */}
                  {canManage && (
                    <select value={thread.priority || 'normal'} onChange={e => setPriorityAction(e.target.value)}
                      title="Conversation priority"
                      style={{ fontSize: 11, fontWeight: 600, padding: '5px 8px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', flexShrink: 0,
                        color: thread.priority === 'urgent' ? 'var(--bad-fg)' : thread.priority === 'high' ? 'var(--warn-fg)' : 'var(--t2)' }}>
                      {PRIORITY_OPTS.map(p => <option key={p} value={p}>{PRIORITIES[p].label}</option>)}
                    </select>
                  )}
                  {/* Past orders (Pruthvi) — LOADED ON CLICK, never on open. ShopifyPanel without
                      `autoLoad` renders its own Search button, so mounting it costs nothing until an
                      agent asks. Deliberate: this hits Shopify live, and the inbox is already the
                      surface agents call slow. */}
                  {hasOrdersKey && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button className="ps-ibtn" onClick={() => setOrdersOpen(v => !v)} style={ICON_BTN}
                        title="This customer's previous orders">
                        <ShoppingBag size={13} />
                      </button>
                      {ordersOpen && (
                        <Popover onClose={() => setOrdersOpen(false)} width={420} placement="down" align="right" maxH={460}>
                          {/* key=thread.id forces a REMOUNT per conversation. ShopifyPanel holds its
                              result in internal state and (deliberately) does not auto-refetch when
                              props change, so without this an agent switching threads would be shown
                              the PREVIOUS customer's orders under the new customer's name. */}
                          <ShopifyPanel key={thread.id} session={session} phone={ordersPhone} email={ordersEmail} />
                        </Popover>
                      )}
                    </div>
                  )}
                  {/* Ticket — the live link stays visible text; Create/Link go behind one icon. */}
                  {convo?.linked_ticket ? (
                    <a href={`/queue/detail?ticket_no=${convo.linked_ticket.ticket_no}`}
                      style={{ ...btnGhost, textDecoration: 'none', padding: '5px 9px', fontSize: 12, flexShrink: 0 }}
                      title="Open the linked ticket">
                      <Link2 size={12} /> {convo.linked_ticket.ticket_no}
                    </a>
                  ) : canManage && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button className="ps-ibtn" onClick={() => setTicketMenuOpen(v => !v)} style={ICON_BTN}
                        title="Create or link a ticket">
                        <Link2 size={13} />
                      </button>
                      {ticketMenuOpen && (
                        <Popover onClose={() => setTicketMenuOpen(false)} width={220} placement="down" align="right" scroll={false}>
                          <button onClick={() => { setTicketMenuOpen(false); createTicketFromConvo(); }}
                            style={{ ...btnGhost, width: '100%', justifyContent: 'flex-start', padding: '7px 9px',
                              fontSize: 12, marginBottom: 6, marginTop: 14 }}
                            title="Create a new ticket from this conversation and link it">
                            <Plus size={12} /> Create ticket
                          </button>
                          <button onClick={() => { setTicketMenuOpen(false); setLinkOpen(true); }}
                            style={{ ...btnGhost, width: '100%', justifyContent: 'flex-start', padding: '7px 9px', fontSize: 12 }}
                            title="Link an existing ticket by number">
                            <Link2 size={12} /> Link ticket
                          </button>
                        </Popover>
                      )}
                    </div>
                  )}
                  {canManage && (
                    thread.thread_state === 'closed' ? (
                      <>
                        {thread.closed_reason && (
                          <span title={thread.closed_note || ''}
                            style={{ fontSize: 10.5, fontWeight: 700, padding: '5px 8px', borderRadius: 'var(--radius-sm)',
                              border: '1px solid', whiteSpace: 'nowrap', flexShrink: 0,
                              borderColor: thread.closed_reason === 'resolved' ? 'var(--ok-bd)' : 'var(--border)',
                              background:  thread.closed_reason === 'resolved' ? 'var(--ok-bg)' : 'var(--surface-2)',
                              color:       thread.closed_reason === 'resolved' ? 'var(--ok-fg)' : 'var(--t3)' }}>
                            {CLOSE_REASON_LABEL[thread.closed_reason] || thread.closed_reason}
                          </span>
                        )}
                        <button onClick={() => setThreadStateAction('open')} title="Reopen this conversation"
                          style={{ ...btnGhost, padding: '5px 9px', fontSize: 12, flexShrink: 0 }}>
                          <RotateCcw size={12} /> Reopen
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setThreadStateAction('closed', 'resolved')}
                          style={{ ...btnGhost, padding: '5px 9px', fontSize: 12, flexShrink: 0,
                            color: 'var(--ok-fg)', borderColor: 'var(--ok-bd)' }}
                          title="The customer's issue was sorted">
                          <CheckCircle2 size={12} /> Resolve
                        </button>
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          <button onClick={() => setCloseOpen(v => !v)}
                            style={{ ...btnGhost, padding: '5px 9px', fontSize: 12 }}
                            title="Close without resolving — pick a reason">
                            <XCircle size={12} /> Close
                          </button>
                          {closeOpen && (
                            <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 40,
                              width: 260, padding: 10, borderRadius: 'var(--radius)', background: 'var(--surface)',
                              border: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,0.28)' }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 7 }}>
                                Why is this being closed?
                              </div>
                              <select value={closeReason} onChange={e => setCloseReason(e.target.value)}
                                style={{ width: '100%', fontSize: 12, padding: '7px 8px', marginBottom: 7,
                                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                                  background: 'var(--surface-2)', color: 'var(--t1)' }}>
                                <option value="">Select a reason…</option>
                                {CLOSE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select>
                              <input value={closeNote} onChange={e => setCloseNote(e.target.value)}
                                placeholder="Note (optional)" maxLength={300}
                                style={{ width: '100%', fontSize: 12, padding: '7px 8px', marginBottom: 8,
                                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                                  background: 'var(--surface-2)', color: 'var(--t1)' }} />
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button onClick={() => { setCloseOpen(false); setCloseReason(''); setCloseNote(''); }}
                                  style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }}>Cancel</button>
                                <button disabled={!closeReason}
                                  onClick={() => setThreadStateAction('closed', closeReason, closeNote)}
                                  style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5,
                                    opacity: closeReason ? 1 : 0.45, cursor: closeReason ? 'pointer' : 'default',
                                    color: 'var(--t1)' }}>Close</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )
                  )}
                  {/* Release · Transfer… · Transfer to Influencer team — one icon, the existing
                      AssignControl popover unchanged behind it. */}
                  {canManage && !isIgnitionThread && (
                    <AssignControl
                      thread={thread} mineThread={mineThread} canReassign={canReassign} agents={agents}
                      open={assignOpen} setOpen={setAssignOpen} onAssign={assign} onTransfer={transfer}
                      onTransferToIgnition={transferToIgnition} myId={myId} />
                  )}
                </div>
              </div>

              {/* Collab pre-flag (2026-07-28, Pruthvi). A suggestion, never an automatic
                  move — the agent decides. Hidden once transferred or dismissed. */}
              {thread.collab_flagged && !thread.collab_dismissed && !isIgnitionThread && canManage && (
                <div style={{ padding: '9px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
                  alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--warn-bg)' }}>
                  <Sparkles size={13} style={{ color: 'var(--warn-fg)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: 'var(--warn-fg)', fontWeight: 600 }}>
                    Looks like a collab enquiry
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                    matched “{thread.collab_keyword}”
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button onClick={() => transferToIgnition(`Collab pre-flag: matched "${thread.collab_keyword}"`)}
                      style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }}
                      title="Hand this conversation to the Influencer team">
                      <ExternalLink size={11} /> Transfer to Ignition
                    </button>
                    <button onClick={dismissCollab} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }}
                      title="Not a collab — stop flagging this conversation">
                      Not a collab
                    </button>
                  </div>
                </div>
              )}

              {/* Link-ticket inline row. Needs its own dismiss: the trigger used to be a visible
                  TOGGLE button, and it is now a one-way menu item, so without this the row can
                  only be closed by actually linking a ticket. */}
              {linkOpen && !convo?.linked_ticket && (
                <div style={{ flexShrink: 0, padding: '10px 16px', borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)' }}>
                  <input autoFocus value={linkVal} onChange={e => setLinkVal(e.target.value)} placeholder="CS-2026-NNNNN"
                    onKeyDown={e => {
                      if (e.key === 'Enter') linkTicket();
                      else if (e.key === 'Escape') { setLinkOpen(false); setLinkVal(''); }
                    }}
                    style={{ ...inputStyle, flex: 1 }} />
                  <button onClick={linkTicket} style={btnPrimary} disabled={!linkVal.trim()}>Link</button>
                  <button className="ps-ibtn" onClick={() => { setLinkOpen(false); setLinkVal(''); }}
                    title="Cancel linking" style={ICON_BTN}>
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* ⚠️ These two banners sit OUTSIDE the scrolling message list ON PURPOSE.
                  The list pins itself to the newest message on every thread open
                  (`el.scrollTop = el.scrollHeight`), so anything rendered as its first child is
                  scrolled out of sight immediately on any thread longer than one screen — which is
                  exactly where a "this thread may be stale" warning matters most. Keep them here,
                  pinned above the scroller. Found by hostile review 2026-08-21; they shipped inside
                  the scroller earlier the same day and were effectively invisible. */}
              {/* ⚠️ A stale mirror must not look identical to a live thread. When the Chatwoot
                  pull fails, `loadConvo` falls back to the DB-mirrored view — which only ever
                  held OUR outbound side — and stamps `wa_live_error`. Until 2026-08-21 nothing
                  read it, so the agent saw a conversation that could be missing every inbound
                  message the customer sent, with no way to tell. Silent degradation to a
                  plausible-looking wrong answer is the worst failure shape available here. */}
              {convo?.wa_live_error && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
                  background: 'var(--warn-bg, #fef3c7)', border: '1px solid var(--warn-fg, #d97706)',
                  borderRadius: 'var(--radius-sm)', padding: '8px 10px',
                  color: 'var(--warn-fg, #92400e)', fontSize: 12, lineHeight: 1.45,
                }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong>Showing a mirrored copy — this may be missing the customer&apos;s latest messages.</strong>{' '}
                    The live conversation could not be loaded ({convo.wa_live_error}).{' '}
                    <button onClick={() => loadConvo(convo.thread.id)} style={{
                      background: 'none', border: 'none', padding: 0, font: 'inherit',
                      color: 'inherit', textDecoration: 'underline', cursor: 'pointer',
                    }}>Retry</button>
                  </span>
                </div>
              )}

              {/* `startConversation` sets `newNote` when the customer already had an open 24h
                  window, so the template was deliberately NOT sent and the agent was moved
                  straight here. Unrendered, that read as the compose box silently discarding
                  their message. The note explains why nothing was sent — the window is open,
                  so they can just type. */}
              {newNote && (newNote.threadId == null || newNote.threadId === selectedId) && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
                  background: 'var(--info-bg, #eff6ff)', border: '1px solid var(--info-fg, #2563eb)',
                  borderRadius: 'var(--radius-sm)', padding: '8px 10px',
                  color: 'var(--info-fg, #1e40af)', fontSize: 12, lineHeight: 1.45,
                }}>
                  <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ flex: 1 }}>{newNote.text}</span>
                  <button onClick={() => setNewNote(null)} title="Dismiss" style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'inherit', flexShrink: 0, lineHeight: 0,
                  }}>
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* Messages */}
              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: 'var(--surface-2)' }}>
                {/* Load older — WA/web history is Chatwoot-paged; deepen on demand up to 36 pages */}
                {!oldestReached && (convo?.messages || []).length > 0 && (
                  <div style={{ textAlign: 'center', marginBottom: 12 }}>
                    <button onClick={loadOlderMessages} disabled={loadingOlder} style={{
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                      color: 'var(--t2)', fontSize: 12, padding: '6px 14px',
                      cursor: loadingOlder ? 'default' : 'pointer', opacity: loadingOlder ? 0.6 : 1 }}>
                      {loadingOlder ? 'Loading…' : '↑ Load older messages'}
                    </button>
                  </div>
                )}
                {loadingConvo && !convo?.messages?.length ? (
                  <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>Loading thread…</div>
                ) : (convo?.messages || []).length === 0 ? (
                  <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>No messages yet.</div>
                ) : convo.messages.map(m => <Bubble key={m.id} m={m} accent={ch.color} />)}
              </div>

              {/* Composer — suppressed for transferred / oversight threads (read-only handoff, S177) */}
              {readOnlyView ? (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex',
                  alignItems: 'center', gap: 8, background: 'var(--surface-2)' }}>
                  <ExternalLink size={13} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>
                    Transferred to the Influencer team — read-only oversight. Replies are handled in Ignition.
                  </span>
                </div>
              ) : ch.sendable ? (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12,
                  background: noteMode ? 'var(--warn-bg)' : 'transparent' }}>
                  {noteMode ? (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Lock size={11} /> Internal note — only your team can see this. Never sent to the customer.
                    </div>
                  ) : !windowOpen && (
                    <div style={{ marginBottom: 7 }}>
                      {/* THREE different situations. WhatsApp: a genuine block, escapable with a
                          template. Instagram/Messenger: the 7-day human-agent allowance is real,
                          but gated behind an App Review permission we do NOT hold, so until it
                          lands the honest line is that Meta refuses the reply. "Your reply still
                          sends" printed above a send that then fails is worse than the old flat
                          "window closed" — it makes the app look broken rather than restricted
                          (Pruthvi 2026-08-05). Past 7 days it is shut regardless of approval. */}
                      <div style={{ fontSize: 10.5, color: (metaStillSends && META_HUMAN_AGENT_APPROVED) ? 'var(--t3)' : 'var(--warn-fg)',
                        display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Clock size={11} /> {isWa
                          ? 'Outside the 24h window — free-text replies are blocked. Send an approved template to reopen the conversation.'
                          : (metaStillSends && META_HUMAN_AGENT_APPROVED)
                            ? `Past 24h — your reply still sends${metaDaysLeft != null ? ` (${metaDaysLeft} of 7 days left)` : ' under Meta\u2019s 7-day support window'}.`
                            : metaStillSends
                              ? 'Past 24h — Meta will refuse this reply. Replying this late needs its Human Agent approval, which is still pending. The customer messaging again reopens the chat.'
                              : 'Past 7 days — Meta no longer accepts a reply on this conversation.'}
                      </div>
                      {isWa && canManage && !tplOpen && (
                        <button onClick={openTemplates}
                          style={{ ...btnGhost, marginTop: 7, fontSize: 11, padding: '5px 10px',
                            display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <FileText size={12} /> Send template
                        </button>
                      )}
                    </div>
                  )}


                  {/* Email headers — To / Cc / Bcc / Subject (S181). Reply mode only. */}
                  {isEmail && !noteMode && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                      <EmailField label="To" value={emailTo} onChange={setEmailTo} disabled={!canManage} placeholder="customer@example.com" />
                      {showCcBcc ? (
                        <>
                          <EmailField label="Cc"  value={emailCc}  onChange={setEmailCc}  disabled={!canManage} placeholder="comma-separated" />
                          <EmailField label="Bcc" value={emailBcc} onChange={setEmailBcc} disabled={!canManage} placeholder="comma-separated" />
                        </>
                      ) : (
                        <button type="button" onClick={() => setShowCcBcc(true)} disabled={!canManage}
                          style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', cursor: canManage ? 'pointer' : 'default',
                            color: 'var(--accent)', fontSize: 11, fontWeight: 600, padding: '1px 2px' }}>
                          + Cc / Bcc
                        </button>
                      )}
                      <EmailField label="Subject" value={emailSubject} onChange={setEmailSubject} disabled={!canManage} placeholder="Subject" />
                    </div>
                  )}

                  {/* Toolbar */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 6, position: 'relative', alignItems: 'center' }}>
                    <ToolBtn title="Emoji" onClick={() => { setShowEmoji(v => !v); setShowCanned(false); }} disabled={!canManage}><Smile size={15} /></ToolBtn>
                    {noteMode ? (
                      <>
                        <ToolBtn title="Bold" onClick={() => wrapSelection('**')} disabled={!canManage}><Bold size={15} /></ToolBtn>
                        <ToolBtn title="Italic" onClick={() => wrapSelection('_')} disabled={!canManage}><Italic size={15} /></ToolBtn>
                      </>
                    ) : (
                      <>
                        <ToolBtn title="Canned responses (or type / in the box)" onClick={() => { setShowCanned(v => !v); setShowEmoji(false); }} disabled={!canManage}>
                          <FileText size={15} />
                        </ToolBtn>
                        {canAttach && (
                          <ToolBtn title={isEmail ? 'Attach files (images, PDF, docs — up to 15MB total)' : 'Attach image / PDF'} onClick={() => fileRef.current?.click()} disabled={!canManage}>
                            <Paperclip size={15} />
                          </ToolBtn>
                        )}
                        <input ref={fileRef} type="file" accept={attachAccept} multiple={isEmail}
                          onChange={onPickFile} style={{ display: 'none' }} />
                      </>
                    )}
                    <ToolBtn title={noteMode ? 'Switch to reply mode' : 'Private note (internal only)'} active={noteMode}
                      onClick={() => { setMode(noteMode ? 'reply' : 'note'); if (!noteMode) setPendingFiles([]); }}
                      disabled={!canManage}><StickyNote size={15} /></ToolBtn>
                    {/* WhatsApp Template (S245) — sits beside Private Note per Pruthvi's spec.
                        Always available, not only when the window is shut: an agent may want a
                        structured message either way, and after a number migration EVERY window
                        is shut, so this is the only route back into a conversation. */}
                    {isWa && !noteMode && (
                      <ToolBtn title="WhatsApp template (reopen a conversation)" active={tplOpen}
                        onClick={() => { if (tplOpen) { setTplOpen(false); } else { setShowEmoji(false); setShowCanned(false); openTemplates(); } }}
                        disabled={!canManage}><MessageCircle size={15} /></ToolBtn>
                    )}
                    {isWa && tplOpen && !noteMode && (
                      <Popover onClose={() => { setTplOpen(false); setTplId(''); setTplVals({}); }} width={380}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)', marginBottom: 8 }}>
                          WhatsApp templates
                        </div>

                        <select value={tplId} style={{ ...selectStyle, width: '100%', marginBottom: 10 }}
                          onChange={(e) => { setTplId(e.target.value); setTplVals({}); }}>
                          <option value="">{tplList.length ? 'Choose a template…' : 'Loading templates…'}</option>
                          {tplList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>

                        {tplSel && (
                          <>
                            <div style={{ fontSize: 9.5, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>BODY</div>
                            {/* Live preview of the approved copy — the agent sees the actual
                                message, not just a template name, before it goes out. */}
                            <div style={{ fontSize: 11.5, color: 'var(--t2)', whiteSpace: 'pre-wrap',
                              background: 'var(--surface-2)', border: '1px solid var(--border)',
                              borderRadius: 6, padding: 8, marginBottom: 10, maxHeight: 160, overflowY: 'auto' }}>
                              {tplPreview(tplSel, tplVals)}
                            </div>

                            {tplSel.fields.filter((f) => !f.auto).map((f) => (
                              <div key={f.token} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <span style={{ fontSize: 10, color: 'var(--t3)', background: 'var(--surface-2)',
                                  border: '1px solid var(--border)', borderRadius: 4, padding: '3px 7px', minWidth: 22, textAlign: 'center' }}>
                                  {f.pos}
                                </span>
                                <input style={{ ...inputStyle, flex: 1 }}
                                  placeholder={f.example ? `${f.label} — e.g. ${f.example}` : f.label}
                                  value={tplVals[f.token] || ''}
                                  onChange={(e) => setTplVals((v) => ({ ...v, [f.token]: e.target.value }))} />
                              </div>
                            ))}

                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                              <span style={{ fontSize: 9.5, color: 'var(--t3)' }}>{tplSel.meta_name}</span>
                              <button onClick={sendTemplate}
                                disabled={tplSending || tplSel.fields.some((f) => !f.auto && !String(tplVals[f.token] || '').trim())}
                                style={{ ...btnPrimary, fontSize: 11, padding: '6px 12px' }}>
                                {tplSending ? 'Sending…' : 'Send template'}
                              </button>
                            </div>
                          </>
                        )}
                      </Popover>
                    )}
                    {showEmoji && (
                      <Popover onClose={() => setShowEmoji(false)} width="auto" pad={0} hideClose scroll={false}>
                        <EmojiPicker onSelect={(native) => insertAtCaret(native)} />
                      </Popover>
                    )}
                    {(showCanned || slashActive) && !noteMode && (
                      <Popover onClose={() => { setShowCanned(false); setCannedDraft(null); }} width={320}>
                        <CannedPanel
                          slashActive={slashActive} query={cannedQuery} list={filteredCanned}
                          search={cannedSearch} setSearch={setCannedSearch} canManage={canManage}
                          draft={cannedDraft} setDraft={setCannedDraft}
                          onPick={pickCanned} onSave={saveCanned} saving={savingCanned} />
                      </Popover>
                    )}
                  </div>

                  {/* Staged attachment preview (reply mode) — one row per file (S201) */}
                  {pendingFiles.length > 0 && !noteMode && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 6 }}>
                      {pendingFiles.map((pf, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                          {pf.mime.startsWith('image/')
                            ? <img src={pf.dataUrl} alt="" style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                            : <FileText size={22} style={{ color: 'var(--t3)', flexShrink: 0 }} />}
                          <span style={{ fontSize: 12, color: 'var(--t2)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {pf.name} <span style={{ color: 'var(--t4)' }}>· {(pf.size / 1024).toFixed(0)} KB</span>
                          </span>
                          <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} title="Remove"
                            style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--t3)', display: 'grid', placeItems: 'center' }}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      ref={taRef}
                      value={text}
                      onChange={e => { const v = e.target.value; setText(v); if (!noteMode && v.startsWith('/')) { setShowCanned(true); setShowEmoji(false); } }}
                      onKeyDown={e => {
                        if (e.key === 'Escape') { setShowCanned(false); setShowEmoji(false); setCannedDraft(null); return; }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          if (slashActive && filteredCanned.length) { e.preventDefault(); pickCanned(filteredCanned[0]); return; }
                          e.preventDefault(); send();
                        }
                      }}
                      placeholder={!canManage ? 'You need cs_ticket_manage to reply.'
                        : noteMode ? 'Write an internal note for the team…  (Enter to save)'
                        : waReplyBlocked ? 'Waiting on the customer — WhatsApp replies need an open 24h window.'
                        : pendingFiles.length ? 'Add a message (optional)…  (Enter to send)'
                        : 'Type a reply…  (Enter to send, Shift+Enter for newline)'}
                      disabled={!canManage || sending || waReplyBlocked} rows={2}
                      style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'var(--f-ui)',
                        background: noteMode ? 'var(--surface)' : inputStyle.background }} />
                    <button onClick={send} disabled={!canManage || sending || waReplyBlocked || (!text.trim() && !pendingFiles.length)}
                      style={{ ...btnPrimary, opacity: (!canManage || sending || waReplyBlocked || (!text.trim() && !pendingFiles.length)) ? 0.5 : 1,
                        background: noteMode ? 'var(--warn-fg)' : btnPrimary.background }}>
                      {noteMode ? <StickyNote size={13} /> : pendingFiles.length ? <Paperclip size={13} /> : <Send size={13} />}
                      {sending ? 'Sending' : noteMode ? 'Save note' : 'Send'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex',
                  alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--surface-2)' }}>
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>Read-only mirror — reply in BiteSpeed to deliver.</span>
                  <a href={biteSpeedLink(thread)} target="_blank" rel="noreferrer" style={{ ...btnPrimary, textDecoration: 'none' }}>
                    <ExternalLink size={13} /> Reply in BiteSpeed
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {/* Compose lives HERE, in the component that OWNS `newOpen` — it was written inside the
          Bubble component, which renders a single message. The inbox LIST has no Bubbles, so the
          page looked fine; opening any conversation rendered a Bubble, hit an out-of-scope
          `newOpen`, and white-screened the whole inbox (ReferenceError, live 2026-07-30 22:43).
          A clean `next build` cannot catch this — identifier resolution is a RUNTIME step. */}
        {/* ── New conversation (Compose) ────────────────────────────────────────────────
            A business-initiated WhatsApp message is only allowed via an APPROVED template, so the
            template picker is the body of this dialog rather than an afterthought. The same live
            preview as the in-thread picker is used deliberately: the agent should see the exact
            words a stranger is about to receive from us. */}
        {newOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center',
            background: 'rgba(0,0,0,0.55)' }}
            onClick={(e) => { if (e.target === e.currentTarget) setNewOpen(false); }}>
            <div style={{ width: 460, maxHeight: '86vh', overflowY: 'auto', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>New conversation</div>
                <button onClick={() => setNewOpen(false)} title="Close" style={{ background: 'transparent', border: 'none',
                  color: 'var(--t3)', cursor: 'pointer' }}><X size={15} /></button>
              </div>

              {/* Channel first: it changes every field below it, and email is the one agents will
                  actually reach for — WhatsApp compose is a rare "can't find the conversation" tool. */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                {[['whatsapp', 'WhatsApp'], ['email', 'Email']].map(([id, label]) => (
                  <button key={id} onClick={() => { setNewChannel(id); setErr(null); }} style={{
                    flex: 1, cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)', border: '1px solid',
                    borderColor: newChannel === id ? 'var(--accent)' : 'var(--border)',
                    background: newChannel === id ? 'var(--accent-bg)' : 'transparent',
                    color: newChannel === id ? 'var(--accent)' : 'var(--t2)' }}>{label}</button>
                ))}
              </div>

              {newChannel === 'email' ? (
                <>
                  <div style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>TO</div>
                  <input style={{ ...inputStyle, width: '100%', marginBottom: 10 }} placeholder="customer@example.com"
                    value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoFocus />

                  <div style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>SUBJECT</div>
                  <input style={{ ...inputStyle, width: '100%', marginBottom: 10 }} placeholder="Subject"
                    value={newSubject} onChange={(e) => setNewSubject(e.target.value)} />

                  <div style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>MESSAGE</div>
                  <textarea style={{ ...inputStyle, width: '100%', minHeight: 130, resize: 'vertical', marginBottom: 6 }}
                    placeholder="Write the email…" value={newBody} onChange={(e) => setNewBody(e.target.value)} />
                  <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 12 }}>
                    If this customer already has an open email conversation from the last 7 days,
                    this is added to it rather than starting a second one.
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={startConversation}
                      disabled={newSending || !newEmail.trim() || !newSubject.trim() || !newBody.trim()}
                      style={{ ...btnPrimary, fontSize: 11, padding: '6px 12px' }}>
                      {newSending ? 'Sending…' : 'Send & open'}
                    </button>
                  </div>
                </>
              ) : (
              <>
              <div style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>PHONE</div>
              <input style={{ ...inputStyle, width: '100%', marginBottom: 4 }} placeholder="9880212323 or +919880212323"
                value={newPhone} onChange={(e) => setNewPhone(e.target.value)} autoFocus />
              <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 12 }}>
                A 10-digit number is treated as Indian (+91). If this customer already has an open
                24-hour window we&apos;ll just open that conversation instead of spending a template.
              </div>

              <div style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>TEMPLATE</div>
              <select value={newTplId} style={{ ...selectStyle, width: '100%', marginBottom: 10 }}
                onChange={(e) => { setNewTplId(e.target.value); setNewVals({}); }}>
                <option value="">{tplList.length ? 'Choose a template…' : 'Loading templates…'}</option>
                {tplList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>

              {(() => {
                const sel = tplList.find((t) => t.id === newTplId) || null;
                if (!sel) return null;
                return (
                  <>
                    <div style={{ fontSize: 9.5, letterSpacing: '0.05em', color: 'var(--t3)', marginBottom: 4 }}>PREVIEW</div>
                    <div style={{ fontSize: 11.5, color: 'var(--t2)', whiteSpace: 'pre-wrap',
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: 8, marginBottom: 10, maxHeight: 180, overflowY: 'auto' }}>
                      {tplPreview(sel, newVals)}
                    </div>
                    {sel.fields.filter((f) => !f.auto).map((f) => (
                      <div key={f.token} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, color: 'var(--t3)', background: 'var(--surface-2)',
                          border: '1px solid var(--border)', borderRadius: 4, padding: '3px 7px', minWidth: 22, textAlign: 'center' }}>
                          {f.pos}
                        </span>
                        <input style={{ ...inputStyle, flex: 1 }}
                          placeholder={f.example ? `${f.label} — e.g. ${f.example}` : f.label}
                          value={newVals[f.token] || ''}
                          onChange={(e) => setNewVals((v) => ({ ...v, [f.token]: e.target.value }))} />
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                      <span style={{ fontSize: 9.5, color: 'var(--t3)' }}>{sel.meta_name}</span>
                      <button onClick={startConversation}
                        disabled={newSending || !newPhone.trim()
                          || sel.fields.some((f) => !f.auto && !String(newVals[f.token] || '').trim())}
                        style={{ ...btnPrimary, fontSize: 11, padding: '6px 12px' }}>
                        {newSending ? 'Sending…' : 'Send & open'}
                      </button>
                    </div>
                  </>
                );
              })()}
              </>
              )}
            </div>
          </div>
        )}
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────── */
function displayName(t) {
  return t?.customer_handle || t?.customer_phone || (t?.external_user_id ? `User ${String(t.external_user_id).slice(-6)}` : 'Unknown');
}
function Empty({ children }) {
  return <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>{children}</div>;
}
function ToolBtn({ children, title, onClick, disabled, active }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ display: 'grid', placeItems: 'center', width: 30, height: 28, cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? 'var(--warn-fg)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--warn-bg)' : 'var(--surface)',
        color: disabled ? 'var(--t4)' : active ? 'var(--warn-fg)' : 'var(--t2)', opacity: disabled ? 0.5 : 1 }}>{children}</button>
  );
}
// One labelled email-header input row (To / Cc / Bcc / Subject) — S181.
function EmailField({ label, value, onChange, disabled, placeholder }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 52, flexShrink: 0, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--t3)', textAlign: 'right' }}>{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} disabled={disabled} placeholder={placeholder}
        style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          padding: '5px 9px', color: 'var(--t1)', fontSize: 12.5, fontFamily: 'var(--f-ui)', outline: 'none' }} />
    </div>
  );
}
/* Anchored popover. The transparent fixed backdrop catches any outside click and closes it
   (click-outside-to-dismiss for every composer popup — S162); Esc closes it too.
   `placement` / `align` were added for the command-bar era: this component was built for the
   composer, which opens UPWARD from the bottom of the pane, while every popover in the command
   bar and the conversation header opens DOWNWARD — and the ones anchored to a right-hand
   control must align right or they hang off the edge of the window.
   ⚠️ The defaults ('up' / 'left') are the pre-existing behaviour, so the three composer callers
   (template · emoji · canned) are byte-identical. Do not change the defaults. */
function Popover({ children, onClose, width = 280, pad = 10, hideClose = false, scroll = true,
  placement = 'up', align = 'left', maxH = 320 }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
      <div style={{ position: 'absolute', zIndex: 40, width,
        ...(placement === 'down' ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' }),
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: pad,
        ...(scroll ? { maxHeight: maxH, overflowY: 'auto' } : {}) }}>
        {!hideClose && (
          <button onClick={onClose} title="Close" style={{ position: 'absolute', top: 6, right: 6, zIndex: 1, cursor: 'pointer',
            border: 'none', background: 'transparent', color: 'var(--t3)' }}><X size={13} /></button>
        )}
        {children}
      </div>
    </>
  );
}
function CannedPanel({ slashActive, query, list, search, setSearch, canManage, draft, setDraft, onPick, onSave, saving }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingRight: 16 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Canned responses</span>
        {canManage && !draft && (
          <button onClick={() => setDraft({ title: '', body: '' })} style={{ ...btnGhost, padding: '3px 8px', fontSize: 11 }}>
            <Plus size={12} /> New
          </button>
        )}
      </div>
      {draft ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input autoFocus value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            placeholder="Title (e.g. Refund acknowledged)" style={{ ...inputStyle, fontSize: 12 }} />
          <textarea value={draft.body} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            placeholder="Response text…" rows={3} style={{ ...inputStyle, resize: 'vertical', fontSize: 12, fontFamily: 'var(--f-ui)' }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setDraft(null)} style={{ ...btnGhost, padding: '4px 10px', fontSize: 11 }}>Cancel</button>
            <button onClick={onSave} disabled={saving || !draft.title.trim() || !draft.body.trim()}
              style={{ ...btnPrimary, padding: '4px 10px', fontSize: 11, opacity: (saving || !draft.title.trim() || !draft.body.trim()) ? 0.5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {slashActive ? (
            <div style={{ fontSize: 10.5, color: 'var(--t3)', marginBottom: 6 }}>Filtering by <code>/{query}</code> — Enter picks the top match.</div>
          ) : (
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--t4)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{ ...inputStyle, fontSize: 12, paddingLeft: 26 }} />
            </div>
          )}
          {list.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--t3)', padding: '8px 0' }}>{query ? 'No match.' : 'No canned responses yet — add one with “New”.'}</div>
          ) : list.map((c, i) => (
            <button key={c.id} onClick={() => onPick(c)}
              style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '7px 8px', border: 'none',
                borderRadius: 6, background: (slashActive && i === 0) ? 'var(--accent-bg)' : 'transparent', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)' }}>{c.title}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.body}</div>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
/* Who owns this conversation, as a badge — and Claim, which is deliberately still ONE click
   (§13.2: it is the most-used control on the header row, so it never goes behind an icon).
   Split out of AssignControl so the badge can sit early in the right cluster while Release /
   Transfer sit at its far end, per the approved layout. */
function AssignBadge({ thread, mineThread, myId, onAssign }) {
  if (mineThread) return <ToneBadge tone="ok"><UserPlus size={10} style={{ marginRight: 3 }} /> Mine</ToneBadge>;
  if (thread.assigned_agent_id) return <ToneBadge tone="info">{thread.assigned_agent_name || 'Assigned'}</ToneBadge>;
  return (
    <button onClick={() => onAssign(myId)} title="Assign this conversation to yourself"
      style={{ ...btnPrimary, padding: '5px 11px', fontSize: 11.5, flexShrink: 0 }}>
      <UserPlus size={12} /> Claim
    </button>
  );
}
/* Release · Transfer… · Transfer to the Influencer team, behind one titled icon button.
   The panel itself is unchanged from when Transfer… was visible text; Release moved INTO it
   (it was a sibling button) and is the first thing in it, since that is the common case for a
   thread you own. */
function AssignControl({ thread, mineThread, canReassign, agents, open, setOpen, onAssign, onTransfer, onTransferToIgnition, myId }) {
  const assigned = thread.assigned_agent_id;
  const [sel, setSel] = useState('');
  const [note, setNote] = useState('');
  const [ignConfirm, setIgnConfirm] = useState(false);   // two-step confirm for the Ignition handoff (S177)
  // Transfer scope (mirrors the worker): leads can transfer any thread; a regular
  // agent can transfer one they own or that's unassigned (not steal another's).
  const ownsOrFree = !assigned || assigned === myId;
  const canTransfer = canReassign || ownsOrFree;
  const openPanel = () => { setSel(''); setNote(''); setIgnConfirm(false); setOpen(true); };
  const targets = (agents || []).filter(a => a.id !== assigned);   // can't transfer to the current owner
  const submit = () => { if (sel) onTransfer(sel, note.trim() || null); };
  const submitIgnition = () => onTransferToIgnition?.(note.trim() || null);
  // Nothing behind the button when the agent may neither release nor transfer (someone else's
  // thread, no reassign perm) — so it does not render at all rather than opening an empty panel.
  if (!canTransfer) return null;
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      <button className="ps-ibtn" onClick={openPanel} style={ICON_BTN}
        title={mineThread ? 'Release or transfer this conversation' : 'Transfer this conversation'}>
        <Users size={13} />
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
      )}
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: 260,
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: 10 }}>
          {mineThread && (
            <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => onAssign(null)} title="Give this conversation back to the unassigned pool"
                style={{ ...btnGhost, width: '100%', justifyContent: 'center', padding: '7px 0', fontSize: 12 }}>
                Release
              </button>
            </div>
          )}
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Transfer to</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 8 }}>
            {targets.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 4px' }}>No other agents available.</div>
            ) : targets.map(a => (
              <button key={a.id} onClick={() => setSel(a.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '7px 8px', border: `1px solid ${sel === a.id ? 'var(--accent-bd)' : 'transparent'}`, borderRadius: 6,
                  background: sel === a.id ? 'var(--accent-bg)' : 'transparent', fontSize: 12, color: 'var(--t1)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: sel === a.id ? 'var(--accent)' : 'var(--border-2)' }} />
                {a.full_name}{a.id === myId ? ' (me)' : ''}
              </button>
            ))}
          </div>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder="Add a note for them (optional)…"
            style={{ width: '100%', resize: 'none', fontSize: 12, padding: '6px 8px', marginBottom: 8,
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-2)',
              color: 'var(--t1)', fontFamily: 'var(--f-ui)' }} />
          <button onClick={submit} disabled={!sel}
            style={{ ...btnPrimary, width: '100%', justifyContent: 'center', padding: '7px 0', fontSize: 12,
              opacity: sel ? 1 : 0.5, cursor: sel ? 'pointer' : 'default' }}>
            <UserPlus size={12} /> Transfer
          </button>

          {/* Hand off to the Influencer team (Ignition) — full transfer out of CS (S177).
              Reuses the note box above as the optional handoff note. */}
          {onTransferToIgnition && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase',
                letterSpacing: '0.08em', marginBottom: 6 }}>Influencer team</div>
              {ignConfirm ? (
                <>
                  <div style={{ fontSize: 11, color: 'var(--warn-fg)', marginBottom: 8, lineHeight: 1.4 }}>
                    This conversation will leave the CS inbox and move to the Influencer team (Ignition).
                    You&apos;ll keep read-only visibility. This can&apos;t be undone from here.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setIgnConfirm(false)}
                      style={{ ...btnGhost, flex: 1, justifyContent: 'center', padding: '7px 0', fontSize: 12 }}>
                      Cancel
                    </button>
                    <button onClick={submitIgnition}
                      style={{ ...btnPrimary, flex: 1, justifyContent: 'center', padding: '7px 0', fontSize: 12,
                        background: 'var(--warn-fg)' }}>
                      <ExternalLink size={12} /> Confirm
                    </button>
                  </div>
                </>
              ) : (
                <button onClick={() => setIgnConfirm(true)}
                  style={{ ...btnGhost, width: '100%', justifyContent: 'center', padding: '7px 0', fontSize: 12 }}>
                  <ExternalLink size={12} /> Transfer to Influencer team
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
/* ══════════════════════════════════════════════════════════════════════════════════════
   InboxCommandBar — one 40px row that owns ALL scoping and filtering.

   It replaces six stacked bands: the channel tile row AND the <Tabs> strip (both of which
   set the same `channel` state — the same control twice), plus the conversation list's own
   header, assignment axis, filter selects, search and select rows, which were a row of small
   controls stacked vertically inside a 320px column: the most expensive place to put them.

   Everything is re-homed, nothing is dropped. The two figures that left the screen are
   per-channel `awaiting` (now one aggregate topbar pill + each segment's tooltip) and
   per-channel `closed` (reachable via the Closed state filter) — signed off in §13.
   Lives here rather than in components/: it reads a dozen values off the page's state and
   has no reuse anywhere, so extracting it would only add a prop-drilling surface.
   ══════════════════════════════════════════════════════════════════════════════════════ */
function InboxCommandBar(props) {
  const {
    channel, setChannel, stats, allTotal,
    assignTabs, assignTab, setAssignTab,
    stateFilter, setStateFilter,
    ignitionScope, onToggleIgnition, soundOn, onToggleSound, notifOn, notifPermission, onToggleNotif,
    searchInput, setSearchInput,
    sort, setSort, priorityFilter, setPriorityFilter, tagFilter, setTagFilter,
    agentFilter, setAgentFilter, allTags, agents,
    wabaFilter, setWabaFilter, waNumbers,
    filtersOpen, setFiltersOpen, filtersDirty, clearFilters, miniSelect,
    canManage, canReassign, selectMode, onToggleSelect, onCompose,
    listCollapsed, toggleListCollapse,
  } = props;

  // Self-measuring: the bar sheds weight only when it genuinely does not fit, so collapsing
  // the sidebar, resizing the window and a long agent name all feed the same one signal.
  const barRef = useRef(null);
  const spacerRef = useRef(null);
  const fit = useFitLadder(barRef, spacerRef);
  const compact = {
    hideActiveLabel: fit >= 1,   // active segment → glyph + count only
    searchWidth:     fit >= 2 ? 150 : 200,
    composeIconOnly: fit >= 3,
    assignInPopover: fit >= 4,   // axis moves into the filters popover
  };

  // Shared segment shell. `on` drives the accent treatment; every variant keeps the same
  // border box so the row never shifts by a pixel when the selection moves.
  const seg = (on, extra = {}) => ({
    display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
    borderRadius: 'var(--radius-sm)', border: '1px solid',
    borderColor: on ? 'var(--accent-bd)' : 'var(--border)',
    background: on ? 'var(--accent-bg)' : 'transparent',
    fontFamily: 'var(--f-ui)', transition: `background var(--fast) var(--ease)`,
    ...extra,
  });

  return (
    <div ref={barRef} style={{ height: 40, flexShrink: 0, background: 'var(--bg)', borderBottom: '1px solid var(--border)',
      padding: '0 14px', display: 'flex', alignItems: 'center', gap: 8 }}>

      {/* ── Channel scope. Tab behaviour, NOT the old tile behaviour: clicking the active
             segment does not toggle back to 'all'. ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
        ...(compact.hideActiveLabel ? { overflow: 'hidden' } : {}) }}>
        {SEGMENT_KEYS.map(k => {
          const isAll = k === 'all';
          const c = isAll ? null : chanOf(k);
          const on = channel === k;
          const total = isAll ? allTotal : (stats[k]?.total || 0);
          const unread = isAll ? 0 : (stats[k]?.unread || 0);   // same source as the tiles' "N new" pill (S222)
          // The tiles' visible channel label lives here now, so hover still names every channel.
          const title = isAll ? `All channels · ${allTotal}` : `${c.label}${unread ? ` · ${unread} new` : ''}`;
          // Only the active segment spends width on its text label — and it gives that up first
          // when the bar gets tight. 'All' always shows text: it has no glyph to fall back on.
          const showLabel = isAll || (on && !compact.hideActiveLabel);
          return (
            <button key={k} onClick={() => setChannel(k)} title={title} className={on ? undefined : 'ps-seg'}
              style={{ position: 'relative', padding: on ? '5px 9px' : '5px 8px',
                borderColor: on ? 'var(--accent-bd)' : 'transparent',
                background: on ? 'var(--accent-bg)' : 'transparent',
                border: '1px solid', borderRadius: 'var(--radius-sm)',
                display: 'flex', alignItems: 'center', gap: on ? 6 : 5,
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                fontFamily: 'var(--f-ui)', fontSize: 12, fontWeight: on ? 700 : 500,
                color: on ? 'var(--t1)' : 'var(--t2)',
                transition: `background var(--fast) var(--ease)` }}>
              {c && <c.Glyph size={14} style={{ color: c.color, flexShrink: 0 }} />}
              {showLabel && (isAll ? 'All' : c.label)}
              <span className="num" style={on
                ? { fontFamily: 'var(--f-mono)', fontSize: 10, background: 'var(--accent-bg)',
                    color: 'var(--accent)', borderRadius: 99, padding: '0 5px' }
                : isAll
                  ? { fontFamily: 'var(--f-mono)', fontSize: 10, background: 'var(--surface-2)',
                      color: 'var(--t4)', borderRadius: 99, padding: '0 5px' }
                  : { fontSize: 10.5 }}>{total}</span>
              {/* Unread dot — a new customer message nobody has opened yet. */}
              {unread > 0 && (
                <span style={{ position: 'absolute', top: 2, right: 1, width: 6, height: 6,
                  borderRadius: '50%', background: c.color }} />
              )}
            </button>
          );
        })}
      </div>

      <BarDivider />

      {/* ── Assignment axis. Folds into the filters popover on a narrow window rather than
             being clipped (§5.13 step 4). ───────────────────────────────────────────────── */}
      {!compact.assignInPopover && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            {assignTabs.map(t => (
              <button key={t.id} onClick={() => setAssignTab(t.id)} className={assignTab === t.id ? undefined : 'ps-seg'}
                title={`${t.label} — ${t.count} conversation${t.count === 1 ? '' : 's'}`}
                style={seg(assignTab === t.id, { fontSize: 11, fontWeight: 600, padding: '4px 8px',
                  color: assignTab === t.id ? 'var(--accent)' : 'var(--t2)' })}>
                {t.label}
                <span className="num" style={{ fontSize: 10, opacity: 0.7 }}>{t.count}</span>
              </button>
            ))}
          </div>
          <BarDivider />
        </>
      )}

      {/* ── State · Ignition scope · sound ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        {/* Hidden under the Ignition scope, which bypasses the state facet entirely (S177). */}
        {!ignitionScope && [['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([id, lbl]) => (
          <button key={id} onClick={() => setStateFilter(id)} title={`Show ${lbl.toLowerCase()} conversations`}
            className={stateFilter === id ? undefined : 'ps-seg'}
            style={seg(stateFilter === id, { fontSize: 10, fontWeight: 600, padding: '3px 7px',
              color: stateFilter === id ? 'var(--accent)' : 'var(--t3)' })}>{lbl}</button>
        ))}
        {/* Read-only oversight: threads transferred to the Influencer team (leads/admin, S177).
            Icon-only now — the label moved into `title`. */}
        {canReassign && (
          <button onClick={onToggleIgnition} className={ignitionScope ? undefined : 'ps-seg'}
            title="View conversations transferred to the Influencer team (read-only)"
            style={seg(ignitionScope, { padding: '4px 6px',
              color: ignitionScope ? 'var(--accent)' : 'var(--t3)' })}>
            <ExternalLink size={11} />
          </button>
        )}
        {/* Chime toggle (S245). Opt-in and per-browser: a shared desk with several agents
            does not want a chorus. The tab badge is always on and needs no permission. */}
        <button onClick={onToggleNotif} className={notifOn ? undefined : 'ps-seg'}
          title={notifPermission === 'unsupported'
            ? 'Desktop notifications are not supported in this browser'
            : notifPermission === 'denied'
              ? 'Blocked — allow notifications for this site in your browser settings'
              : notifOn
                ? 'Desktop notification on new customer message — click to turn off'
                : 'Off — click for desktop notifications when this tab is in the background'}
          disabled={notifPermission === 'unsupported'}
          style={seg(notifOn, { padding: '4px 6px',
            color: notifOn ? 'var(--accent)' : (notifPermission === 'denied' ? 'var(--bad-fg)' : 'var(--t3)'),
            opacity: notifPermission === 'unsupported' ? 0.4 : 1 })}>
          <Monitor size={11} />
        </button>
        <button onClick={onToggleSound} className={soundOn ? undefined : 'ps-seg'}
          title={soundOn ? 'Chime on new customer message — click to mute' : 'Muted — click to chime on new customer messages'}
          style={seg(soundOn, { padding: '4px 6px', color: soundOn ? 'var(--accent)' : 'var(--t3)' })}>
          {soundOn ? <Bell size={11} /> : <BellOff size={11} />}
        </button>
      </div>

      {/* ── Right cluster starts here ─────────────────────────────────────────────────────
             The spacer does what `margin-left: auto` used to: absorb the free space. Reading
             its width is the only way to know the bar has HEADROOM, which `scrollWidth`
             cannot report — see useFitLadder. */}
      <div ref={spacerRef} style={{ flex: '1 1 0', minWidth: 0 }} />
      {/* `data-search-primary` is what the layout's global `/` shortcut focuses. */}
      <div style={{ position: 'relative', width: compact.searchWidth, flexShrink: 0 }}>
        <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--t4)', pointerEvents: 'none' }} />
        <input data-search-primary value={searchInput} onChange={e => setSearchInput(e.target.value)}
          placeholder="Search phone or name…"
          style={{ ...inputStyle, fontSize: 11.5, padding: `5px ${searchInput ? 24 : 10}px 5px 26px` }} />
        {searchInput && (
          <button onClick={() => setSearchInput('')} title="Clear search"
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--t3)', display: 'grid', placeItems: 'center', padding: 0 }}>
            <X size={12} />
          </button>
        )}
      </div>

      {/* ── Filters popover — sort · priority · tag · agent (verbatim), so four selects stop
             costing two wrapped rows in a 320px column. ─────────────────────────────────── */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button className="ps-ibtn" onClick={() => setFiltersOpen(v => !v)} style={BAR_BTN}
          title={compact.assignInPopover ? 'Assignment · sort · priority · tag · agent' : 'Sort · priority · tag · agent'}>
          <SlidersHorizontal size={13} />
          {/* An applied filter must never be invisible — that is how an agent concludes the
              inbox is empty when it is merely filtered. */}
          {filtersDirty && (
            <span style={{ position: 'absolute', top: -2, right: -2, width: 6, height: 6,
              borderRadius: '50%', background: 'var(--accent)' }} />
          )}
        </button>
        {filtersOpen && (
          <Popover onClose={() => setFiltersOpen(false)} width={260} placement="down" align="right">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              {compact.assignInPopover && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {assignTabs.map(t => (
                    <button key={t.id} onClick={() => setAssignTab(t.id)}
                      style={seg(assignTab === t.id, { flex: 1, justifyContent: 'center', fontSize: 11,
                        fontWeight: 600, padding: '5px 4px',
                        color: assignTab === t.id ? 'var(--accent)' : 'var(--t2)' })}>
                      {t.label}<span className="num" style={{ fontSize: 10, opacity: 0.7 }}>{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
              <select value={sort} onChange={e => setSort(e.target.value)} title="Sort conversations"
                style={{ ...miniSelect, flex: 'none', width: '100%' }}>
                <option value="recent">↓ Recent activity</option>
                <option value="oldest">↑ Oldest first</option>
                <option value="priority">★ Priority</option>
              </select>
              <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} title="Filter by priority"
                style={{ ...miniSelect, flex: 'none', width: '100%' }}>
                <option value="">All priorities</option>
                {PRIORITY_OPTS.map(p => <option key={p} value={p}>{PRIORITIES[p].label}</option>)}
              </select>
              {/* Which LOT number the customer wrote to (S262, Pruthvi). WhatsApp-only —
                  no other channel has more than one inbound address — so it is hidden
                  unless the WhatsApp segment (or All) is showing, where it applies. */}
              {waNumbers.length > 1 && (channel === 'whatsapp' || channel === 'all') && (
                <select value={wabaFilter} onChange={e => setWabaFilter(e.target.value)} title="Filter by the LOT number it came to"
                  style={{ ...miniSelect, flex: 'none', width: '100%' }}>
                  <option value="">All LOT numbers</option>
                  {waNumbers.map(n => (
                    <option key={n.phone_number_id} value={n.phone_number_id}>
                      {n.label}{n.purpose ? ` · ${n.purpose}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {allTags.length > 0 && (
                <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} title="Filter by tag"
                  style={{ ...miniSelect, flex: 'none', width: '100%' }}>
                  <option value="">All tags</option>
                  {allTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {canReassign && agents.length > 0 && (
                <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} title="Filter by assigned agent"
                  style={{ ...miniSelect, flex: 'none', width: '100%' }}>
                  <option value="">All agents</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.full_name || a.email}</option>)}
                </select>
              )}
              <button onClick={clearFilters} disabled={!filtersDirty}
                style={{ ...btnGhost, width: '100%', justifyContent: 'center', padding: '6px 0', fontSize: 11.5,
                  opacity: filtersDirty ? 1 : 0.45, cursor: filtersDirty ? 'pointer' : 'default' }}>
                Clear filters
              </button>
            </div>
          </Popover>
        )}
      </div>

      {/* Select mode — gates the per-row checkboxes (S236). Toggling OFF goes through
          exitSelectMode so a selection can never be stranded behind hidden checkboxes. */}
      <button className={selectMode ? undefined : 'ps-ibtn'} onClick={onToggleSelect}
        title={selectMode ? 'Leave select mode' : 'Select conversations for bulk assign'}
        style={{ ...BAR_BTN,
          borderColor: selectMode ? 'var(--accent-bd)' : 'var(--border-2)',
          background: selectMode ? 'var(--accent-bg)' : 'transparent',
          color: selectMode ? 'var(--accent)' : 'var(--t2)' }}>
        <CheckSquare size={13} />
      </button>

      {/* Compose — the ONLY way to reach a customer who has not written to us. Without it a
          thread could only be born from an inbound message (a regression vs BiteSpeed). */}
      {canManage && (
        <button className="ps-ibtn" onClick={onCompose} title="New WhatsApp or email conversation"
          style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, cursor: 'pointer',
            fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
            padding: compact.composeIconOnly ? 0 : '4px 9px',
            ...(compact.composeIconOnly ? { display: 'grid', placeItems: 'center', width: 28, height: 26 } : {}),
            border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
            background: 'transparent', color: 'var(--t2)' }}>
          <Plus size={12} />{!compact.composeIconOnly && 'Compose'}
        </button>
      )}

      {/* Collapse the thread list. The bar itself never changes when collapsed. */}
      <button className="ps-ibtn" onClick={toggleListCollapse}
        title={listCollapsed ? 'Expand conversation list' : 'Collapse conversation list'}
        style={{ ...BAR_BTN, borderColor: 'var(--border)', color: 'var(--t3)' }}>
        {listCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
      </button>
    </div>
  );
}
function BarDivider() {
  return <div style={{ width: 1, height: 20, background: 'var(--border)', flexShrink: 0 }} />;
}
function Avatar({ t, size = 34 }) {
  const ch = chanOf(t?.channel);
  const ltr = (displayName(t)[0] || '?').toUpperCase();
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--surface-3)',
        border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center',
        fontWeight: 700, fontSize: size * 0.42, color: 'var(--t2)' }}>{ltr}</div>
      <div style={{ position: 'absolute', right: -2, bottom: -2, width: 15, height: 15, borderRadius: '50%',
        background: 'var(--surface)', display: 'grid', placeItems: 'center' }}>
        <ch.Glyph size={11} style={{ color: ch.color }} />
      </div>
    </div>
  );
}
function ThreadRow({ t, active, myId, onClick, noBorder }) {
  const ch = chanOf(t.channel);
  const lm = t.last_message;
  const preview = lm ? (lm.body || (lm.kind && lm.kind !== 'text' ? `[${lm.kind}]` : '')) : '';
  const mine = t.assigned_agent_id && t.assigned_agent_id === myId;
  // Unread / needs-attention (S222, Pruthvi): a NEW customer message arrived after the
  // thread was last opened, and it isn't Done. Server-computed team-global read state
  // (`t.unread` from the last_inbound_at>last_read_at watermark) — clears when anyone
  // opens the thread, NOT only on reply (the S191 heuristic over-flagged every
  // awaiting-reply thread forever). Falls back to the old heuristic if the field is
  // absent (stale payload during rollout). Signalled three ways — a filled dot, a bolder
  // name, a darker preview — plus a faint tint when the row isn't the active selection.
  const unread = t.unread ?? (!!lm && lm.direction === 'inbound' && t.thread_state !== 'closed');
  return (
    <button onClick={onClick} style={{ width: '100%', textAlign: 'left', cursor: 'pointer',
      display: 'flex', gap: 10, padding: '11px 13px', border: 'none',
      borderBottom: noBorder ? 'none' : '1px solid var(--border)',
      background: active ? 'var(--surface-2)' : (unread ? 'var(--surface-2, rgba(255,255,255,0.03))' : 'transparent'),
      borderLeft: `2px solid ${active ? ch.color : (unread ? ch.color : 'transparent')}` }}>
      <Avatar t={t} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {unread && <span title="New customer message" style={{ width: 7, height: 7, borderRadius: '50%',
              background: ch.color, flexShrink: 0, boxShadow: `0 0 0 2px ${ch.color}33` }} />}
            <span style={{ fontSize: 13, fontWeight: unread ? 800 : 600, color: 'var(--t1)', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(t)}</span>
          </span>
          <span className="num" style={{ fontSize: 10, color: unread ? 'var(--t2)' : 'var(--t4)', flexShrink: 0 }}>{relTime(t.last_message_at)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {lm?.direction === 'outbound' && <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>You:</span>}
          <span style={{ fontSize: 12, color: unread ? 'var(--t1)' : 'var(--t3)', fontWeight: unread ? 600 : 400,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{preview || '—'}</span>
        </div>
        <div style={{ display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' }}>
          {t.priority && t.priority !== 'normal' && (
            <ToneBadge tone={PRIORITIES[t.priority]?.tone || 'mute'} style={{ fontSize: 8.5 }}>{PRIORITIES[t.priority]?.label || t.priority}</ToneBadge>
          )}
          {t.thread_state === 'closed' && <ToneBadge tone="mute" style={{ fontSize: 8.5 }}>Done</ToneBadge>}
          {t.assigned_agent_id && (
            <ToneBadge tone={mine ? 'ok' : 'mute'} style={{ fontSize: 8.5 }}>{mine ? 'Mine' : (t.assigned_agent_name || 'Assigned')}</ToneBadge>
          )}
          {t.linked_ticket_no && (
            <ToneBadge tone="info" style={{ fontSize: 8.5 }}>{t.linked_ticket_no}</ToneBadge>
          )}
          {(t.tags || []).map(tag => <TagChip key={tag.id} tag={tag} small />)}
        </div>
      </div>
    </button>
  );
}
function noteHtml(s) {
  // Minimal **bold** / _italic_ rendering for internal notes (escaped first).
  const esc = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>');
}
function Bubble({ m, accent }) {
  const { session } = useAuth();
  // Per-attachment open state (index being fetched, and the last error). Hooks stay
  // above the internal-note early return so the call order is unconditional.
  const [attBusy, setAttBusy] = useState(null);
  const [attErr, setAttErr] = useState(null);

  // Inbound customer attachments live on a PRIVATE bucket, so there is no durable URL
  // to put in an href — we mint a 120s signed one per click. The blank tab is opened
  // SYNCHRONOUSLY inside the gesture, then pointed at the URL once it resolves;
  // opening after the await is what popup blockers kill.
  const openAttachment = async (idx) => {
    if (attBusy !== null) return;
    setAttBusy(idx); setAttErr(null);
    const tab = window.open('', '_blank');
    try {
      const d = await csopsGet('getEmailAttachment', { message_id: m.id, idx: String(idx) }, session);
      if (!d?.url) throw new Error('No URL returned');
      if (tab) tab.location = d.url;
      else setAttErr('Allow pop-ups for this site to open attachments');
    } catch (e) {
      if (tab) tab.close();
      setAttErr(String(e?.message || e).replace(/^Error:\s*/, ''));
    } finally { setAttBusy(null); }
  };

  // Internal note — full-width, centered, amber, never customer-facing (S162-B).
  if (m.is_internal || m.kind === 'note') {
    const ts = m.sent_at || m.created_at;
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 9 }}>
        <div style={{ maxWidth: '86%', padding: '8px 12px', borderRadius: 10, background: 'var(--warn-bg)',
          border: '1px dashed var(--warn-bd, var(--warn-fg))' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--warn-fg)', textTransform: 'uppercase',
            letterSpacing: '0.05em', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Lock size={10} /> Internal note{m.sent_by_name ? ` · ${m.sent_by_name}` : ''}
          </div>
          <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            dangerouslySetInnerHTML={{ __html: noteHtml(m.body || '') }} />
          <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--t4)', textAlign: 'right' }}>{shortTime(ts)}</div>
        </div>
      </div>
    );
  }
  const isIn = m.direction === 'inbound';
  const ts = m.received_at || m.sent_at || m.created_at;
  const failed = m.status === 'failed';
  // Email HTML — render in a sandboxed iframe (no scripts / no same-origin) so
  // arbitrary customer markup can't run or escape. Wider bubble for readability.
  //
  // The iframe's sandbox carries `allow-popups allow-popups-to-escape-sandbox`, and
  // both flags are load-bearing. An EMPTY sandbox enables every restriction — popups
  // and top-navigation included — so every anchor in every inbound email was silently
  // inert: a click did nothing and raised no error (Maria 2026-08-01, on a customer's
  // Gmail Drive video chip; 2,857 of 3,784 inbound emails carry a link, so this was
  // never video-specific). `allow-popups-to-escape-sandbox` is required, not cosmetic:
  // without it the opened tab INHERITS this sandbox and Drive — or any real site —
  // renders blank, which reads as the very same bug. Scripts and same-origin stay OFF,
  // so the markup still cannot run or open anything by itself; only a genuine agent
  // click on a genuine anchor navigates.
  //
  // `<base target="_blank">` is prepended so a link with no target of its own opens
  // a new tab instead of loading the site INSIDE the 560px bubble.
  const emailHtml = m.channel === 'email' && m.body_html
    ? `<base target="_blank">${m.body_html}` : null;
  // Email attachments (S201) — list every file as a download chip (multi-file safe).
  const emailAtts = m.channel === 'email' && Array.isArray(m.raw_meta?.attachments) ? m.raw_meta.attachments : null;
  return (
    <div style={{ display: 'flex', justifyContent: isIn ? 'flex-start' : 'flex-end', marginBottom: 9 }}>
      <div style={{ maxWidth: emailHtml ? '92%' : '74%', padding: '8px 12px', borderRadius: 12,
        borderBottomLeftRadius: isIn ? 3 : 12, borderBottomRightRadius: isIn ? 12 : 3,
        background: isIn ? 'var(--surface)' : 'var(--accent-bg)',
        border: `1px solid ${isIn ? 'var(--border)' : 'var(--accent-bd, var(--border-2))'}` }}>
        {m.kind === 'template' && (
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--info-fg)', textTransform: 'uppercase',
            letterSpacing: '0.05em', marginBottom: 4 }}>Template · {m.template_name}</div>
        )}
        {emailAtts ? (
          <div style={{ marginBottom: (m.body || emailHtml) ? 6 : 2 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {emailAtts.map((a, i) => {
                const chip = { display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 220,
                  padding: '3px 8px', borderRadius: 999, fontSize: 11, border: '1px solid var(--border)', background: 'var(--surface)' };
                const label = <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.filename || 'attachment'}</span>;
                const busy = attBusy === i;
                // Outbound sends carry a public url (hosted at send time) — plain link.
                if (a.url) {
                  return <a key={i} href={a.url} target="_blank" rel="noreferrer" style={{ ...chip, color: 'var(--accent)', textDecoration: 'none' }}><FileText size={11} />{label}</a>;
                }
                // Inbound with stored bytes — mint a signed URL on click.
                if (a.storage_path) {
                  return (
                    <button key={i} type="button" onClick={() => openAttachment(i)} disabled={busy}
                      title={`${a.filename || 'attachment'}${a.size ? ` · ${fmtBytes(a.size)}` : ''}`}
                      style={{ ...chip, color: 'var(--accent)', cursor: busy ? 'progress' : 'pointer',
                        font: 'inherit', fontSize: 11, opacity: busy ? 0.6 : 1 }}>
                      <FileText size={11} />{label}
                    </button>
                  );
                }
                // Neither: say WHY rather than a bare "unavailable" (a skipped reason is
                // recorded at ingest — oversize, fetch failure, etc.).
                return (
                  <span key={i} style={{ ...chip, color: 'var(--t3)', opacity: 0.75 }}
                    title={ATT_SKIP_REASON[a.skipped] || 'Preview unavailable — open the email in Gmail'}>
                    <FileText size={11} />{label}
                  </span>
                );
              })}
            </div>
            {attErr && <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--bad-fg)' }}>{attErr}</div>}
          </div>
        ) : m.media_url && (m.kind === 'image' ? (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginBottom: m.body ? 6 : 2 }}>
            <img src={m.media_url} alt={m.media_filename || 'image'}
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, display: 'block' }} />
          </a>
        ) : m.kind === 'share' ? (
          /* A reel/post the customer shared. This is the whole point of the share work:
             the agent has to see WHICH product is being asked about, so the link is a
             prominent chip rather than the generic "media" anchor. The caption, when Meta
             sends one, renders below as the message body. */
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            marginBottom: m.body ? 6 : 2, fontSize: 11.5, color: 'var(--accent)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '5px 9px', background: 'var(--surface-2)' }}>
            <PlayCircle size={13} />Shared a post — view on Instagram
          </a>
        ) : (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 4, fontSize: 11, color: 'var(--accent)' }}>
            <FileText size={12} />{m.media_filename || 'media'}
          </a>
        ))}
        {/* A message with nothing to show must still be VISIBLE. Meta delivers some shares
            as an empty envelope (49 of them since 24 Jul, and deleted/unsupported messages
            land the same way), which rendered as a blank bubble — indistinguishable from a
            rendering bug and impossible for an agent to act on. Say so instead. */}
        {!emailHtml && !m.body && !m.media_url && !(m.attachments?.length) && (
          <div style={{ fontSize: 12, color: 'var(--t3)', fontStyle: 'italic' }}>
            {m.kind === 'share' ? 'Shared a post — Instagram sent no preview' : 'Message not supported — ask the customer to resend'}
          </div>
        )}
        {emailHtml ? (
          <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={emailHtml} title="email body"
            style={{ width: 'min(560px, 70vw)', minHeight: 90, maxHeight: 460, border: 'none',
              background: '#fff', borderRadius: 6, display: 'block' }} />
        ) : m.body && (
          <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
        )}
        <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--t4)', display: 'flex', gap: 7, alignItems: 'center',
          justifyContent: 'flex-end' }}>
          {!isIn && m.sent_by_name && <span style={{ color: 'var(--t4)' }}>{m.sent_by_name}</span>}
          <span>{shortTime(ts)}</span>
          {failed && <span style={{ color: 'var(--bad-fg)', fontWeight: 700 }}>failed</span>}
        </div>
      </div>

    </div>
  );
}
// `agentDaysLeft` is the Instagram/Messenger human-agent remainder (null on WhatsApp, which
// has no such allowance). The remainder is only worth showing while the allowance is usable —
// without the `human_agent` App Review permission Meta refuses the send, so "3d left (7-day)"
// would be counting down a window we cannot actually use (Pruthvi 2026-08-05).
function WindowPill({ open, until, agentDaysLeft = null }) {
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0 || !open) {
    if (META_HUMAN_AGENT_APPROVED && agentDaysLeft != null && agentDaysLeft > 0) {
      return <ToneBadge tone="warn"><Clock size={10} style={{ marginRight: 3 }} /> {agentDaysLeft}d left (7-day)</ToneBadge>;
    }
    return <ToneBadge tone="mute"><Clock size={10} style={{ marginRight: 3 }} /> Window closed</ToneBadge>;
  }
  const h = Math.floor(ms / 3600000); const mn = Math.floor((ms % 3600000) / 60000);
  return <ToneBadge tone="ok"><Clock size={10} style={{ marginRight: 3 }} /> {h}h {mn}m left</ToneBadge>;
}
