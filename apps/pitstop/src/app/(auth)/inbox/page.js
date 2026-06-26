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
import {
  Instagram, Facebook, MessageCircle, Mail, Send, Clock, ExternalLink, Link2,
  FileText, Smile, Lock, Bold, Italic, StickyNote, UserPlus, X, Paperclip, Plus, Search,
  CheckCircle2, RotateCcw, Tag, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { Panel, Tabs, ToneBadge, btnPrimary, btnGhost, inputStyle, selectStyle } from '../../../components/kit/index.js';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import TagPicker, { TagChip } from '../../../components/TagPicker.js';

// Full emoji picker — lazy, client-only (keeps the emoji dataset off the main bundle).
const EmojiPicker = dynamic(() => import('../../../components/EmojiPicker.js'), {
  ssr: false,
  loading: () => <div style={{ padding: 20, fontSize: 12, color: 'var(--t3)' }}>Loading emoji…</div>,
});

const CHANNELS = {
  instagram: { label: 'Instagram', color: '#E1306C', Glyph: Instagram, sendable: true, hasWindow: true },
  messenger: { label: 'Messenger', color: '#0084FF', Glyph: Facebook, sendable: true, hasWindow: true },
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', Glyph: MessageCircle, sendable: true, hasWindow: true },
  // Email (carecrew@, S175) — two-way via Gmail; no 24h customer window (always sendable).
  email:     { label: 'Email',     color: '#7C5CFC', Glyph: Mail, sendable: true, hasWindow: false },
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

const shortTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
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
const BITESPEED_BASE = 'https://chat.bitespeed.co';
const biteSpeedLink = (t) => (t?.provider_account_id && t?.provider_thread_ref)
  ? `${BITESPEED_BASE}/app/accounts/${t.provider_account_id}/conversations/${t.provider_thread_ref}`
  : BITESPEED_BASE;

export default function InboxPage() {
  const { session, user, perms } = useAuth();
  const canManage = !!perms?.cs_ticket_manage;
  const canReassign = !!(perms?.cs_ticket_reassign || perms?.cs_ticket_admin);
  const myId = user?.id || null;

  const [channel, setChannel] = useState('all');
  const [assignTab, setAssignTab] = useState('all');  // all | mine | unassigned (S162-A)
  const [stateFilter, setStateFilter] = useState('active'); // active | closed | all (S163 work-queue)
  const [tagFilter, setTagFilter] = useState('');           // tag facet (S163)
  const [priorityFilter, setPriorityFilter] = useState(''); // '' | urgent|high|normal|low (S164)
  const [agentFilter, setAgentFilter] = useState('');       // '' | assigned-agent id — managers (S164)
  const [sort, setSort] = useState('recent');               // recent | oldest | priority (S164)
  const [allTags, setAllTags] = useState([]);
  const [threads, setThreads] = useState([]);
  const [stats, setStats] = useState({
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    whatsapp:  { total: 0, awaiting: null, mine: 0, unassigned: 0 },
    email:     { total: 0, awaiting: null, mine: 0, unassigned: 0 },
  });
  const [agents, setAgents] = useState([]);
  const [canned, setCanned] = useState([]);
  const [cannedSearch, setCannedSearch] = useState('');
  const [cannedDraft, setCannedDraft] = useState(null);   // null | { title, body } (inline create)
  const [savingCanned, setSavingCanned] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [convo, setConvo] = useState(null);          // { thread, messages, linked_ticket, within_customer_window }
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('reply');          // reply | note (S162-B/C)
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkVal, setLinkVal] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showCanned, setShowCanned] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);   // { name, mime, size, dataUrl } (S162-C)
  const [selectedIds, setSelectedIds] = useState(() => new Set());  // bulk-select thread ids (S164)
  const [bulkAgent, setBulkAgent] = useState('');         // target of the bulk assign action
  const [bulkBusy, setBulkBusy] = useState(false);
  const scrollRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);

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
      if (assignTab !== 'all') p.tab = assignTab;
      if (stateFilter !== 'active') p.state = stateFilter;   // 'active' is the worker default
      if (tagFilter) p.tag = tagFilter;
      if (priorityFilter) p.priority = priorityFilter;
      if (agentFilter) p.agent = agentFilter;
      if (sort !== 'recent') p.sort = sort;
      const d = await csopsGet('getMessagingThreads', p, session);
      setThreads(d?.threads || []);
      setErr(null);   // self-heal: a transient poll/auth blip must not leave a sticky banner (S177)
    } catch (e) { setErr(e.message); }
    finally { setLoadingList(false); }
  }, [session, channel, assignTab, stateFilter, tagFilter, priorityFilter, agentFilter, sort]);

  const loadStats = useCallback(async () => {
    if (!session) return;
    try {
      const d = await csopsGet('getMessagingStats', {}, session);
      if (d?.stats) setStats(d.stats);
    } catch { /* tiles are best-effort */ }
  }, [session]);

  const loadConvo = useCallback(async (id) => {
    if (!session || !id) return;
    try {
      const d = await csopsGet('getMessagingThread', { thread_id: id }, session);
      // WhatsApp: BiteSpeed's webhook only mirrors our outbound side, so pull the
      // live two-way conversation (+ real 24h window) from Chatwoot on demand (C2-B).
      if (d?.thread?.channel === 'whatsapp') {
        try {
          const live = await csopsGet('getWaConversation', { thread_id: id }, session);
          setConvo({ ...d, messages: live.messages || [],
            within_customer_window: !!live.within_customer_window,
            window_until: live.window_until || null, wa_live: !!live.live });
        } catch (e) {
          setConvo({ ...d, wa_live_error: e.message });   // fall back to mirrored view, flag it
        }
      } else {
        setConvo(d);
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
    loadCanned();
  }, [session, canManage, loadCanned]);

  // Open conversation — load on select + 15s poll.
  useEffect(() => {
    if (!selectedId) { setConvo(null); return undefined; }
    setLoadingConvo(true);
    loadConvo(selectedId);
    setMode('reply'); setShowEmoji(false); setShowCanned(false); setAssignOpen(false); setPendingFile(null);
    const iv = setInterval(() => loadConvo(selectedId), 15000);
    return () => clearInterval(iv);
  }, [selectedId, loadConvo]);

  // Auto-scroll to newest on message change.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [convo?.messages?.length, selectedId]);

  // "Awaiting reply" is only meaningful for the two-way channels (IG/FB) — WhatsApp
  // is a read-only BiteSpeed mirror so its awaiting is not tracked here.
  const totalAwaiting = (stats.instagram.awaiting || 0) + (stats.messenger.awaiting || 0);
  const allTotal = useMemo(
    () => (stats.instagram.total || 0) + (stats.messenger.total || 0) + (stats.whatsapp.total || 0) + (stats.email?.total || 0),
    [stats],
  );

  // Assignment-tab counts, scoped to the channel currently in view.
  const scoped = useMemo(() => {
    const ch = channel === 'all' ? ['instagram', 'messenger', 'whatsapp', 'email'] : [channel];
    const sum = (k) => ch.reduce((a, c) => a + (stats[c]?.[k] || 0), 0);
    return { all: sum('total'), mine: sum('mine'), unassigned: sum('unassigned') };
  }, [stats, channel]);

  const tabs = [
    { id: 'all', label: 'All', count: allTotal },
    { id: 'instagram', label: 'Instagram', count: stats.instagram.total },
    { id: 'messenger', label: 'Messenger', count: stats.messenger.total },
    { id: 'whatsapp', label: 'WhatsApp', count: stats.whatsapp.total },
    { id: 'email', label: 'Email', count: stats.email?.total || 0 },
  ];

  const assignTabs = [
    { id: 'all', label: 'All', count: scoped.all },
    { id: 'mine', label: 'Mine', count: scoped.mine },
    { id: 'unassigned', label: 'Unassigned', count: scoped.unassigned },
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

  const ATTACH_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
  function onPickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!ATTACH_MIMES.includes(f.type)) { setErr('Only images (PNG/JPG/WEBP/GIF) or PDF can be attached.'); return; }
    if (f.size > 8 * 1024 * 1024) { setErr('File too large — max 8MB.'); return; }
    setErr(null);
    const reader = new FileReader();
    reader.onload = () => setPendingFile({ name: f.name, mime: f.type, size: f.size, dataUrl: reader.result });
    reader.readAsDataURL(f);
  }

  async function send() {
    if (sending || !convo?.thread) return;
    const t = text.trim();
    // Attachment send (reply mode only) — caption = whatever's in the box.
    if (mode === 'reply' && pendingFile) {
      if (!['instagram', 'messenger'].includes(convo?.thread?.channel)) { setErr('Attachments are only supported on Instagram/Messenger — send text only.'); return; }
      setSending(true); setErr(null);
      try {
        await csopsPost('sendMetaAttachment', {
          thread_id: convo.thread.id, mime_type: pendingFile.mime,
          data_base64: pendingFile.dataUrl, filename: pendingFile.name, caption: t || null,
        }, session);
        setText(''); setPendingFile(null); setShowEmoji(false); setShowCanned(false);
        await loadConvo(selectedId); loadThreads(); loadStats();
      } catch (e) { setErr(e.message); }
      finally { setSending(false); }
      return;
    }
    if (!t) return;
    setSending(true); setErr(null);
    try {
      if (mode === 'note') {
        await csopsPost('addThreadNote', { thread_id: convo.thread.id, text: t }, session);
      } else if (convo.thread.channel === 'whatsapp') {
        await csopsPost('sendWaReply', { thread_id: convo.thread.id, text: t }, session);   // C2-B BiteSpeed tunnel
      } else if (convo.thread.channel === 'email') {
        await csopsPost('sendEmailReply', { thread_id: convo.thread.id, text: t }, session); // Gmail-native, in-thread (S175)
      } else {
        await csopsPost('sendMetaMessage', { thread_id: convo.thread.id, text: t }, session);
      }
      setText(''); setShowEmoji(false); setShowCanned(false);
      await loadConvo(selectedId);
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setSending(false); }
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
  async function bulkAssign() {
    if (selectedIds.size === 0 || !bulkAgent) return;
    setErr(null); setBulkBusy(true);
    const agent_id = bulkAgent === '__release__' ? null : bulkAgent;
    try {
      await csopsPost('bulkAssignThreads', { thread_ids: [...selectedIds], agent_id }, session);
      setSelectedIds(new Set()); setBulkAgent('');
      loadThreads(); loadStats();
    } catch (e) { setErr(e.message); }
    finally { setBulkBusy(false); }
  }

  // Mark the conversation Done (closed) / Reopen (open) — the work-queue toggle (S163).
  async function setThreadStateAction(state) {
    if (!convo?.thread) return;
    setErr(null);
    try {
      await csopsPost('setThreadState', { thread_id: convo.thread.id, state }, session);
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
  const hasWindow = !!ch?.hasWindow;                 // email has no 24h window — always sendable
  const windowOpen = !hasWindow || !!convo?.within_customer_window;
  const mineThread = thread && thread.assigned_agent_id && thread.assigned_agent_id === myId;
  const noteMode = mode === 'note';
  // WhatsApp (C2-B) replies tunnel through BiteSpeed: free-text only, and only
  // inside the 24h customer window (worker enforces; template send is a fast-follow).
  // No outbound attachments on WA in v1 (Chatwoot media send is a later add).
  const isWa = thread?.channel === 'whatsapp';
  const waReplyBlocked = isWa && !noteMode && !windowOpen;
  const canAttach = ['instagram', 'messenger'].includes(thread?.channel);   // Graph URL-attachment path only
  const slashActive = !noteMode && text.startsWith('/');           // "/" quick-access to canned
  const cannedQuery = (slashActive ? text.slice(1) : cannedSearch).trim().toLowerCase();
  const filteredCanned = cannedQuery
    ? canned.filter(c => `${c.title} ${c.body}`.toLowerCase().includes(cannedQuery))
    : canned;

  const miniSelect = { flex: 1, minWidth: 92, fontSize: 11, padding: '4px 6px',
    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--t1)', cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%', minHeight: 420 }}>
      {/* Header tiles — per-channel volume + awaiting-reply. Click to filter. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {['instagram', 'messenger', 'whatsapp', 'email'].map(k => (
          <ChannelTile key={k} chKey={k} stat={stats[k]} active={channel === k}
            onClick={() => setChannel(c => (c === k ? 'all' : k))} />
        ))}
        <AwaitingTile total={totalAwaiting} />
      </div>

      <Tabs tabs={tabs} value={channel} onChange={setChannel} />

      {err && (
        <div style={{ fontSize: 12, color: 'var(--bad-fg)', background: 'var(--bad-bg)',
          border: '1px solid var(--bad-bd)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>{err}</div>
      )}

      {/* Two-pane via grid: list shrinks 320→200, conversation holds a 340px floor so
          it never collapses to a sliver in narrow/zoomed desktop windows (was a fixed
          340 list + flex chat that could squeeze the chat to ~0). */}
      <div style={{ display: 'grid', gridTemplateColumns: listCollapsed ? '28px minmax(340px, 1fr)' : 'minmax(200px, 320px) minmax(340px, 1fr)',
        gap: 14, flex: 1, minHeight: 0 }}>
        {/* ── Thread list ───────────────────────────────────── */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ padding: listCollapsed ? '10px 0' : '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', justifyContent: listCollapsed ? 'center' : 'space-between', gap: 6 }}>
            {!listCollapsed && <span className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>Conversations</span>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {!listCollapsed && [['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([id, lbl]) => (
                <button key={id} onClick={() => setStateFilter(id)} title={`Show ${lbl.toLowerCase()} conversations`}
                  style={{ cursor: 'pointer', fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid', borderColor: stateFilter === id ? 'var(--accent)' : 'var(--border)',
                    background: stateFilter === id ? 'var(--accent-bg)' : 'transparent',
                    color: stateFilter === id ? 'var(--accent)' : 'var(--t3)' }}>{lbl}</button>
              ))}
              <button onClick={toggleListCollapse} title={listCollapsed ? 'Expand conversation list' : 'Collapse conversation list'}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, cursor: 'pointer',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'transparent',
                  color: 'var(--t3)', flexShrink: 0 }}>
                {listCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
              </button>
            </div>
          </div>
          <div style={{ display: listCollapsed ? 'none' : 'contents' }}>
          {/* Assignment axis — Mine / Unassigned / All (S162-A) */}
          <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            {assignTabs.map(t => (
              <button key={t.id} onClick={() => setAssignTab(t.id)} style={{
                flex: 1, cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '5px 6px',
                borderRadius: 'var(--radius-sm)', border: '1px solid',
                borderColor: assignTab === t.id ? 'var(--accent)' : 'var(--border)',
                background: assignTab === t.id ? 'var(--accent-bg)' : 'transparent',
                color: assignTab === t.id ? 'var(--accent)' : 'var(--t2)' }}>
                {t.label} <span className="num" style={{ opacity: 0.7 }}>{t.count}</span>
              </button>
            ))}
          </div>
          {allTags.length > 0 && (
            <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
              <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} title="Filter by tag"
                style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>
                <option value="">All tags</option>
                {allTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {/* Filter + Sort (S164, Pruthvi) */}
          <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <select value={sort} onChange={e => setSort(e.target.value)} title="Sort conversations" style={miniSelect}>
              <option value="recent">↓ Recent activity</option>
              <option value="oldest">↑ Oldest first</option>
              <option value="priority">★ Priority</option>
            </select>
            <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} title="Filter by priority" style={miniSelect}>
              <option value="">All priorities</option>
              {PRIORITY_OPTS.map(p => <option key={p} value={p}>{PRIORITIES[p].label}</option>)}
            </select>
            {canReassign && agents.length > 0 && (
              <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} title="Filter by assigned agent" style={miniSelect}>
                <option value="">All agents</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.full_name || a.email}</option>)}
              </select>
            )}
          </div>
          {/* Bulk multi-select + assign (S164, Pruthvi) */}
          {threads.length > 0 && (() => {
            const visible = threads.map(t => t.id);
            const allSel = visible.every(id => selectedIds.has(id));
            const someSel = visible.some(id => selectedIds.has(id));
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
                background: selectedIds.size > 0 ? 'var(--accent-bg)' : 'transparent' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={allSel}
                    ref={el => { if (el) el.indeterminate = someSel && !allSel; }}
                    onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                  {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select'}
                </label>
                {selectedIds.size > 0 && (
                  <>
                    <select value={bulkAgent} onChange={e => setBulkAgent(e.target.value)} title="Assign selected to…" style={miniSelect}>
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
                    <button onClick={() => { setSelectedIds(new Set()); setBulkAgent(''); }}
                      style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer' }}>
                      Clear
                    </button>
                  </>
                )}
              </div>
            );
          })()}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingList ? (
              <Empty>Loading…</Empty>
            ) : threads.length === 0 ? (
              <Empty>{assignTab === 'unassigned' ? 'No unassigned conversations.' : assignTab === 'mine' ? 'Nothing assigned to you.' : 'No conversations yet.'}</Empty>
            ) : threads.map(t => {
              const checked = selectedIds.has(t.id);
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'stretch',
                  borderBottom: '1px solid var(--border)',
                  background: checked ? 'var(--accent-bg)' : 'transparent' }}>
                  <label onClick={e => e.stopPropagation()}
                    style={{ display: 'flex', alignItems: 'center', padding: '0 4px 0 10px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleSelect(t.id)} style={{ cursor: 'pointer' }} />
                  </label>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ThreadRow t={t} active={t.id === selectedId} myId={myId} onClick={() => setSelectedId(t.id)} noBorder />
                  </div>
                </div>
              );
            })}
          </div>
          </div>{/* end contents wrapper */}
        </div>

        {/* ── Conversation ──────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {!thread ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--t3)', fontSize: 13 }}>
              Select a conversation to view it.
            </div>
          ) : (
            <>
              {/* Header — wraps so the action cluster drops below the title on a
                  narrow/zoomed pane instead of overflowing + clipping (Pruthvi, S177). */}
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
                alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', rowGap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 200px' }}>
                  <Avatar t={thread} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(thread)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                      <ch.Glyph size={11} style={{ color: ch.color }} />
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{ch.label}</span>
                      {thread.channel === 'email' && thread.external_user_id && (
                        <span style={{ fontSize: 11, color: 'var(--t4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          · {thread.external_user_id}</span>
                      )}
                    </div>
                    {thread.channel === 'email' && thread.subject && (
                      <div style={{ fontSize: 11.5, color: 'var(--t2)', fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }} title={thread.subject}>
                        {thread.subject}</div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  justifyContent: 'flex-end', minWidth: 0 }}>
                  {/* Assign / claim (S162-A) */}
                  {canManage && (
                    <AssignControl
                      thread={thread} mineThread={mineThread} canReassign={canReassign} agents={agents}
                      open={assignOpen} setOpen={setAssignOpen} onAssign={assign} onTransfer={transfer} myId={myId} />
                  )}
                  {/* Priority (S164, Pruthvi) */}
                  {canManage && (
                    <select value={thread.priority || 'normal'} onChange={e => setPriorityAction(e.target.value)}
                      title="Conversation priority"
                      style={{ fontSize: 11, fontWeight: 600, padding: '6px 8px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer',
                        color: thread.priority === 'urgent' ? 'var(--bad-fg)' : thread.priority === 'high' ? 'var(--warn-fg)' : 'var(--t2)' }}>
                      {PRIORITY_OPTS.map(p => <option key={p} value={p}>{PRIORITIES[p].label}</option>)}
                    </select>
                  )}
                  {canManage && (
                    thread.thread_state === 'closed' ? (
                      <button onClick={() => setThreadStateAction('open')} style={{ ...btnGhost, padding: '6px 10px' }} title="Reopen this conversation">
                        <RotateCcw size={12} /> Reopen
                      </button>
                    ) : (
                      <button onClick={() => setThreadStateAction('closed')} style={{ ...btnGhost, padding: '6px 10px' }} title="Mark this conversation done">
                        <CheckCircle2 size={12} /> Done
                      </button>
                    )
                  )}
                  {ch.hasWindow && <WindowPill open={windowOpen} until={thread.customer_window_until} />}
                  {convo?.linked_ticket ? (
                    <a href={`/queue/detail?ticket_no=${convo.linked_ticket.ticket_no}`}
                      style={{ ...btnGhost, textDecoration: 'none', padding: '6px 10px' }}>
                      <Link2 size={12} /> {convo.linked_ticket.ticket_no}
                    </a>
                  ) : canManage && (
                    <>
                      <button onClick={createTicketFromConvo} style={{ ...btnGhost, padding: '6px 10px' }}
                        title="Create a new ticket from this conversation and link it">
                        <Plus size={12} /> Create ticket
                      </button>
                      <button onClick={() => setLinkOpen(v => !v)} style={{ ...btnGhost, padding: '6px 10px' }}>
                        <Link2 size={12} /> Link ticket
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Tags */}
              <div style={{ padding: '7px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
                alignItems: 'center', gap: 8, background: 'var(--surface)' }}>
                <Tag size={12} style={{ color: 'var(--t4)', flexShrink: 0 }} />
                <TagPicker session={session} value={convo?.tags || []} onSave={setThreadTagsAction}
                  canManage={canManage} canCreate={canManage} small />
              </div>

              {/* Link-ticket inline row */}
              {linkOpen && !convo?.linked_ticket && (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8,
                  background: 'var(--surface-2)' }}>
                  <input value={linkVal} onChange={e => setLinkVal(e.target.value)} placeholder="CS-2026-NNNNN"
                    onKeyDown={e => e.key === 'Enter' && linkTicket()} style={{ ...inputStyle, flex: 1 }} />
                  <button onClick={linkTicket} style={btnPrimary} disabled={!linkVal.trim()}>Link</button>
                </div>
              )}

              {/* Messages */}
              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: 'var(--surface-2)' }}>
                {loadingConvo && !convo?.messages?.length ? (
                  <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>Loading thread…</div>
                ) : (convo?.messages || []).length === 0 ? (
                  <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>No messages yet.</div>
                ) : convo.messages.map(m => <Bubble key={m.id} m={m} accent={ch.color} />)}
              </div>

              {/* Composer */}
              {ch.sendable ? (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12,
                  background: noteMode ? 'var(--warn-bg)' : 'transparent' }}>
                  {/* Reply / Note toggle */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <ModeBtn active={!noteMode} onClick={() => setMode('reply')} icon={Send} label="Reply" />
                    <ModeBtn active={noteMode} onClick={() => { setMode('note'); setPendingFile(null); }} icon={StickyNote} label="Private note" tone="warn" />
                  </div>

                  {noteMode ? (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Lock size={11} /> Internal note — only your team can see this. Never sent to the customer.
                    </div>
                  ) : !windowOpen && (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} /> {isWa
                        ? 'Outside the 24h window — free-text replies are blocked until the customer messages again (templates coming soon).'
                        : 'Outside the 24h window — sends with a HUMAN_AGENT tag.'}
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
                          <ToolBtn title="Attach image / PDF" onClick={() => fileRef.current?.click()} disabled={!canManage}>
                            <Paperclip size={15} />
                          </ToolBtn>
                        )}
                        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                          onChange={onPickFile} style={{ display: 'none' }} />
                      </>
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

                  {/* Staged attachment preview (reply mode) */}
                  {pendingFile && !noteMode && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 8px',
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                      {pendingFile.mime.startsWith('image/')
                        ? <img src={pendingFile.dataUrl} alt="" style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                        : <FileText size={22} style={{ color: 'var(--t3)', flexShrink: 0 }} />}
                      <span style={{ fontSize: 12, color: 'var(--t2)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pendingFile.name} <span style={{ color: 'var(--t4)' }}>· {(pendingFile.size / 1024).toFixed(0)} KB</span>
                      </span>
                      <button onClick={() => setPendingFile(null)} title="Remove"
                        style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--t3)', display: 'grid', placeItems: 'center' }}>
                        <X size={14} />
                      </button>
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
                        : pendingFile ? 'Add a caption (optional)…  (Enter to send)'
                        : 'Type a reply…  (Enter to send, Shift+Enter for newline)'}
                      disabled={!canManage || sending || waReplyBlocked} rows={2}
                      style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'var(--f-ui)',
                        background: noteMode ? 'var(--surface)' : inputStyle.background }} />
                    <button onClick={send} disabled={!canManage || sending || waReplyBlocked || (!text.trim() && !pendingFile)}
                      style={{ ...btnPrimary, opacity: (!canManage || sending || waReplyBlocked || (!text.trim() && !pendingFile)) ? 0.5 : 1,
                        background: noteMode ? 'var(--warn-fg)' : btnPrimary.background }}>
                      {noteMode ? <StickyNote size={13} /> : pendingFile ? <Paperclip size={13} /> : <Send size={13} />}
                      {sending ? 'Sending' : noteMode ? 'Save note' : pendingFile ? 'Send' : 'Send'}
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
function ModeBtn({ active, onClick, icon: I, label, tone }) {
  const accent = tone === 'warn' ? 'var(--warn-fg)' : 'var(--accent)';
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
      fontSize: 11.5, fontWeight: 600, padding: '5px 11px', borderRadius: 'var(--radius-sm)',
      border: `1px solid ${active ? accent : 'var(--border)'}`,
      background: active ? (tone === 'warn' ? 'var(--warn-bg)' : 'var(--accent-bg)') : 'transparent',
      color: active ? accent : 'var(--t2)' }}>
      <I size={13} /> {label}
    </button>
  );
}
function ToolBtn({ children, title, onClick, disabled }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ display: 'grid', placeItems: 'center', width: 30, height: 28, cursor: disabled ? 'default' : 'pointer',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)',
        color: disabled ? 'var(--t4)' : 'var(--t2)', opacity: disabled ? 0.5 : 1 }}>{children}</button>
  );
}
// Anchored popover. The transparent fixed backdrop catches any outside click and
// closes it (click-outside-to-dismiss for every composer popup — S162).
function Popover({ children, onClose, width = 280, pad = 10, hideClose = false, scroll = true }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
      <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40, width,
        background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: pad,
        ...(scroll ? { maxHeight: 320, overflowY: 'auto' } : {}) }}>
        {!hideClose && (
          <button onClick={onClose} style={{ position: 'absolute', top: 6, right: 6, zIndex: 1, cursor: 'pointer',
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
function AssignControl({ thread, mineThread, canReassign, agents, open, setOpen, onAssign, onTransfer, myId }) {
  const assigned = thread.assigned_agent_id;
  const [sel, setSel] = useState('');
  const [note, setNote] = useState('');
  // Transfer scope (mirrors the worker): leads can transfer any thread; a regular
  // agent can transfer one they own or that's unassigned (not steal another's).
  const ownsOrFree = !assigned || assigned === myId;
  const canTransfer = canReassign || ownsOrFree;
  const openPanel = () => { setSel(''); setNote(''); setOpen(true); };
  const targets = (agents || []).filter(a => a.id !== assigned);   // can't transfer to the current owner
  const submit = () => { if (sel) onTransfer(sel, note.trim() || null); };
  const xferBtn = <button onClick={openPanel} style={{ ...btnGhost, padding: '5px 9px', fontSize: 11 }}>Transfer…</button>;
  // Owned by me → green pill + release + transfer. Owned by other → name (+ transfer for TL+).
  // Unassigned → Claim (+ transfer).
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      {mineThread ? (
        <>
          <ToneBadge tone="ok"><UserPlus size={10} style={{ marginRight: 3 }} /> Mine</ToneBadge>
          <button onClick={() => onAssign(null)} style={{ ...btnGhost, padding: '5px 9px', fontSize: 11 }}>Release</button>
          {canTransfer && xferBtn}
        </>
      ) : assigned ? (
        <>
          <ToneBadge tone="info">{thread.assigned_agent_name || 'Assigned'}</ToneBadge>
          {canTransfer && xferBtn}
        </>
      ) : (
        <>
          <button onClick={() => onAssign(myId)} style={{ ...btnPrimary, padding: '5px 11px', fontSize: 11.5 }}>
            <UserPlus size={12} /> Claim
          </button>
          {canTransfer && xferBtn}
        </>
      )}
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
      )}
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: 260,
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: 10 }}>
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
        </div>
      )}
    </div>
  );
}
function ChannelTile({ chKey, stat, active, onClick }) {
  const ch = chanOf(chKey);
  const tracksAwaiting = stat?.awaiting != null; // WhatsApp/Email (null) don't track awaiting here
  const awaiting = stat?.awaiting || 0;
  const subText = tracksAwaiting ? (awaiting > 0 ? `${awaiting} awaiting reply` : 'all replied')
    : chKey === 'whatsapp' ? 'in BiteSpeed'
    : `${stat?.unassigned || 0} unassigned`;
  const subTone = tracksAwaiting && awaiting > 0 ? 'var(--warn-fg)' : 'var(--t3)';
  return (
    <button onClick={onClick} style={{ flex: '1 1 160px', minWidth: 150, textAlign: 'left', cursor: 'pointer',
      background: 'var(--surface)', border: `1px solid ${active ? ch.color : 'var(--border)'}`,
      borderRadius: 'var(--radius)', padding: 'var(--cardpad)', position: 'relative', overflow: 'hidden',
      boxShadow: active ? `0 0 0 1px ${ch.color}` : 'none' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: ch.color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        <ch.Glyph size={13} style={{ color: ch.color }} />
        <span className="eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.12em' }}>{ch.label}</span>
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: 26, color: 'var(--t1)', lineHeight: 1 }}>{stat?.total || 0}</div>
      <div style={{ fontSize: 11.5, marginTop: 6, fontWeight: 500, color: subTone }}>{subText}</div>
    </button>
  );
}
function AwaitingTile({ total }) {
  return (
    <div style={{ flex: '1 1 160px', minWidth: 150, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'var(--cardpad)',
      position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: total > 0 ? 'var(--warn-fg)' : 'var(--ok-fg)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        <Clock size={13} style={{ color: total > 0 ? 'var(--warn-fg)' : 'var(--ok-fg)' }} />
        <span className="eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.12em' }}>Awaiting reply</span>
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: 26, color: total > 0 ? 'var(--warn-fg)' : 'var(--t1)', lineHeight: 1 }}>{total}</div>
      <div style={{ fontSize: 11.5, marginTop: 6, fontWeight: 500, color: 'var(--t3)' }}>across all channels</div>
    </div>
  );
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
  return (
    <button onClick={onClick} style={{ width: '100%', textAlign: 'left', cursor: 'pointer',
      display: 'flex', gap: 10, padding: '11px 13px', border: 'none',
      borderBottom: noBorder ? 'none' : '1px solid var(--border)',
      background: active ? 'var(--surface-2)' : 'transparent',
      borderLeft: `2px solid ${active ? ch.color : 'transparent'}` }}>
      <Avatar t={t} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(t)}</span>
          <span className="num" style={{ fontSize: 10, color: 'var(--t4)', flexShrink: 0 }}>{relTime(t.last_message_at)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {lm?.direction === 'outbound' && <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>You:</span>}
          <span style={{ fontSize: 12, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', flex: 1 }}>{preview || '—'}</span>
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
  const emailHtml = m.channel === 'email' && m.body_html ? m.body_html : null;
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
        {m.media_url && (m.kind === 'image' ? (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginBottom: m.body ? 6 : 2 }}>
            <img src={m.media_url} alt={m.media_filename || 'image'}
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, display: 'block' }} />
          </a>
        ) : (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 4, fontSize: 11, color: 'var(--accent)' }}>
            <FileText size={12} />{m.media_filename || 'media'}
          </a>
        ))}
        {emailHtml ? (
          <iframe sandbox="" srcDoc={emailHtml} title="email body"
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
function WindowPill({ open, until }) {
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0 || !open) {
    return <ToneBadge tone="mute"><Clock size={10} style={{ marginRight: 3 }} /> Window closed</ToneBadge>;
  }
  const h = Math.floor(ms / 3600000); const mn = Math.floor((ms % 3600000) / 60000);
  return <ToneBadge tone="ok"><Clock size={10} style={{ marginRight: 3 }} /> {h}h {mn}m left</ToneBadge>;
}
