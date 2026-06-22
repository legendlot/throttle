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
import { useAuth } from '@throttle/auth';
import {
  Instagram, Facebook, MessageCircle, Send, Clock, ExternalLink, Link2,
  Image as ImageIcon, FileText, Smile, Lock, Bold, Italic, StickyNote, UserPlus, X,
} from 'lucide-react';
import { Panel, Tabs, ToneBadge, btnPrimary, btnGhost, inputStyle, selectStyle } from '../../../components/kit/index.js';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';

const CHANNELS = {
  instagram: { label: 'Instagram', color: '#E1306C', Glyph: Instagram, sendable: true },
  messenger: { label: 'Messenger', color: '#0084FF', Glyph: Facebook, sendable: true },
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', Glyph: MessageCircle, sendable: false },
};
const chanOf = (c) => CHANNELS[c] || { label: c || 'DM', color: 'var(--t3)', Glyph: MessageCircle, sendable: false };
const EMOJIS = ['👍', '🙏', '😊', '🎉', '❤️', '✅', '👏', '🚗', '📦', '🔧', '⏳', '😅', '🙌', '👌', '🤝', '📸'];

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
  const [threads, setThreads] = useState([]);
  const [stats, setStats] = useState({
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    whatsapp:  { total: 0, awaiting: null, mine: 0, unassigned: 0 },
  });
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
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
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  // List is channel-scoped (WhatsApp has thousands of threads — fetching "all"
  // would bury the low-volume IG/FB threads). Tiles get their own stats call.
  const loadThreads = useCallback(async () => {
    if (!session) return;
    try {
      const p = {};
      if (channel !== 'all') p.channel = channel;
      if (assignTab !== 'all') p.tab = assignTab;
      const d = await csopsGet('getMessagingThreads', p, session);
      setThreads(d?.threads || []);
    } catch (e) { setErr(e.message); }
    finally { setLoadingList(false); }
  }, [session, channel, assignTab]);

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
      setConvo(d);
    } catch (e) { setErr(e.message); }
    finally { setLoadingConvo(false); }
  }, [session]);

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

  // Agents (for assign dropdown) + canned-response templates — load once.
  useEffect(() => {
    if (!session) return;
    if (canReassign) csopsGet('getCsAgents', {}, session).then(d => setAgents(Array.isArray(d) ? d : (d?.data || []))).catch(() => {});
    csopsGet('getWaTemplates', {}, session).then(d => setTemplates(Array.isArray(d) ? d : (d?.data || d?.templates || []))).catch(() => {});
  }, [session, canReassign]);

  // Open conversation — load on select + 15s poll.
  useEffect(() => {
    if (!selectedId) { setConvo(null); return undefined; }
    setLoadingConvo(true);
    loadConvo(selectedId);
    setMode('reply'); setShowEmoji(false); setShowCanned(false); setAssignOpen(false);
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
    () => (stats.instagram.total || 0) + (stats.messenger.total || 0) + (stats.whatsapp.total || 0),
    [stats],
  );

  // Assignment-tab counts, scoped to the channel currently in view.
  const scoped = useMemo(() => {
    const ch = channel === 'all' ? ['instagram', 'messenger', 'whatsapp'] : [channel];
    const sum = (k) => ch.reduce((a, c) => a + (stats[c]?.[k] || 0), 0);
    return { all: sum('total'), mine: sum('mine'), unassigned: sum('unassigned') };
  }, [stats, channel]);

  const tabs = [
    { id: 'all', label: 'All', count: allTotal },
    { id: 'instagram', label: 'Instagram', count: stats.instagram.total },
    { id: 'messenger', label: 'Messenger', count: stats.messenger.total },
    { id: 'whatsapp', label: 'WhatsApp', count: stats.whatsapp.total },
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

  async function send() {
    const t = text.trim();
    if (!t || !convo?.thread || sending) return;
    setSending(true); setErr(null);
    try {
      if (mode === 'note') {
        await csopsPost('addThreadNote', { thread_id: convo.thread.id, text: t }, session);
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
  const windowOpen = !!convo?.within_customer_window;
  const mineThread = thread && thread.assigned_agent_id && thread.assigned_agent_id === myId;
  const noteMode = mode === 'note';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: 'calc(100vh - 132px)', minHeight: 480 }}>
      {/* Header tiles — per-channel volume + awaiting-reply. Click to filter. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {['instagram', 'messenger', 'whatsapp'].map(k => (
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

      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        {/* ── Thread list ───────────────────────────────────── */}
        <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>Conversations</span>
            <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{threads.length}</span>
          </div>
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
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingList ? (
              <Empty>Loading…</Empty>
            ) : threads.length === 0 ? (
              <Empty>{assignTab === 'unassigned' ? 'No unassigned conversations.' : assignTab === 'mine' ? 'Nothing assigned to you.' : 'No conversations yet.'}</Empty>
            ) : threads.map(t => (
              <ThreadRow key={t.id} t={t} active={t.id === selectedId} myId={myId} onClick={() => setSelectedId(t.id)} />
            ))}
          </div>
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
              {/* Header */}
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
                alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <Avatar t={thread} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(thread)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                      <ch.Glyph size={11} style={{ color: ch.color }} />
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{ch.label}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {/* Assign / claim (S162-A) */}
                  {canManage && (
                    <AssignControl
                      thread={thread} mineThread={mineThread} canReassign={canReassign} agents={agents}
                      open={assignOpen} setOpen={setAssignOpen} onAssign={assign} myId={myId} />
                  )}
                  {ch.sendable && <WindowPill open={windowOpen} until={thread.customer_window_until} />}
                  {convo?.linked_ticket ? (
                    <a href={`/queue/detail?ticket_no=${convo.linked_ticket.ticket_no}`}
                      style={{ ...btnGhost, textDecoration: 'none', padding: '6px 10px' }}>
                      <Link2 size={12} /> {convo.linked_ticket.ticket_no}
                    </a>
                  ) : canManage && (
                    <button onClick={() => setLinkOpen(v => !v)} style={{ ...btnGhost, padding: '6px 10px' }}>
                      <Link2 size={12} /> Link ticket
                    </button>
                  )}
                </div>
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
                    <ModeBtn active={noteMode} onClick={() => setMode('note')} icon={StickyNote} label="Private note" tone="warn" />
                  </div>

                  {noteMode ? (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Lock size={11} /> Internal note — only your team can see this. Never sent to the customer.
                    </div>
                  ) : !windowOpen && (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} /> Outside the 24h window — sends with a HUMAN_AGENT tag.
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
                      <ToolBtn title="Canned responses" onClick={() => { setShowCanned(v => !v); setShowEmoji(false); }} disabled={!canManage || !templates.length}>
                        <FileText size={15} />
                      </ToolBtn>
                    )}
                    {showEmoji && (
                      <Popover onClose={() => setShowEmoji(false)}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
                          {EMOJIS.map(e => (
                            <button key={e} onClick={() => { insertAtCaret(e); setShowEmoji(false); }}
                              style={{ fontSize: 18, padding: 4, cursor: 'pointer', background: 'transparent', border: 'none', borderRadius: 6 }}>{e}</button>
                          ))}
                        </div>
                      </Popover>
                    )}
                    {showCanned && !noteMode && (
                      <Popover onClose={() => setShowCanned(false)} width={300}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Canned responses</div>
                        {templates.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '4px 0' }}>No templates yet.</div>
                        ) : templates.map(tp => (
                          <button key={tp.id || tp.name} onClick={() => { insertAtCaret(tp.body || ''); setShowCanned(false); }}
                            style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '7px 8px',
                              border: 'none', borderRadius: 6, background: 'transparent', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)' }}>{tp.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp.body}</div>
                          </button>
                        ))}
                      </Popover>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      ref={taRef}
                      value={text} onChange={e => setText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder={!canManage ? 'You need cs_ticket_manage to reply.'
                        : noteMode ? 'Write an internal note for the team…  (Enter to save)'
                        : 'Type a reply…  (Enter to send, Shift+Enter for newline)'}
                      disabled={!canManage || sending} rows={2}
                      style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'var(--f-ui)',
                        background: noteMode ? 'var(--surface)' : inputStyle.background }} />
                    <button onClick={send} disabled={!canManage || sending || !text.trim()}
                      style={{ ...btnPrimary, opacity: (!canManage || sending || !text.trim()) ? 0.5 : 1,
                        background: noteMode ? 'var(--warn-fg)' : btnPrimary.background }}>
                      {noteMode ? <StickyNote size={13} /> : <Send size={13} />} {sending ? 'Saving' : noteMode ? 'Save note' : 'Send'}
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
function Popover({ children, onClose, width = 280 }) {
  return (
    <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40, width,
      background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: 10, maxHeight: 280, overflowY: 'auto' }}>
      <button onClick={onClose} style={{ position: 'absolute', top: 6, right: 6, cursor: 'pointer', border: 'none',
        background: 'transparent', color: 'var(--t3)' }}><X size={13} /></button>
      {children}
    </div>
  );
}
function AssignControl({ thread, mineThread, canReassign, agents, open, setOpen, onAssign, myId }) {
  const assigned = thread.assigned_agent_id;
  // Owned by me → green pill + release. Owned by other → name (+ reassign for TL+).
  // Unassigned → Claim (+ assign-to for TL+).
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      {mineThread ? (
        <>
          <ToneBadge tone="ok"><UserPlus size={10} style={{ marginRight: 3 }} /> Mine</ToneBadge>
          <button onClick={() => onAssign(null)} style={{ ...btnGhost, padding: '5px 9px', fontSize: 11 }}>Release</button>
        </>
      ) : assigned ? (
        <>
          <ToneBadge tone="info">{thread.assigned_agent_name || 'Assigned'}</ToneBadge>
          {canReassign && <button onClick={() => setOpen(v => !v)} style={{ ...btnGhost, padding: '5px 9px', fontSize: 11 }}>Reassign</button>}
        </>
      ) : (
        <>
          <button onClick={() => onAssign(myId)} style={{ ...btnPrimary, padding: '5px 11px', fontSize: 11.5 }}>
            <UserPlus size={12} /> Claim
          </button>
          {canReassign && <button onClick={() => setOpen(v => !v)} style={{ ...btnGhost, padding: '5px 9px', fontSize: 11 }}>Assign…</button>}
        </>
      )}
      {open && canReassign && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: 240,
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow, 0 8px 28px rgba(0,0,0,0.28))', padding: 8, maxHeight: 300, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Assign to</div>
          {(agents || []).map(a => (
            <button key={a.id} onClick={() => onAssign(a.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '7px 8px',
                border: 'none', borderRadius: 6, background: a.id === myId ? 'var(--accent-bg)' : 'transparent', fontSize: 12, color: 'var(--t1)' }}>
              {a.full_name}{a.id === myId ? ' (me)' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function ChannelTile({ chKey, stat, active, onClick }) {
  const ch = chanOf(chKey);
  const tracksAwaiting = stat?.awaiting != null; // WhatsApp (null) = BiteSpeed mirror
  const awaiting = stat?.awaiting || 0;
  const subText = !tracksAwaiting ? 'in BiteSpeed' : awaiting > 0 ? `${awaiting} awaiting reply` : 'all replied';
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
function ThreadRow({ t, active, myId, onClick }) {
  const ch = chanOf(t.channel);
  const lm = t.last_message;
  const preview = lm ? (lm.body || (lm.kind && lm.kind !== 'text' ? `[${lm.kind}]` : '')) : '';
  const mine = t.assigned_agent_id && t.assigned_agent_id === myId;
  return (
    <button onClick={onClick} style={{ width: '100%', textAlign: 'left', cursor: 'pointer',
      display: 'flex', gap: 10, padding: '11px 13px', border: 'none', borderBottom: '1px solid var(--border)',
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
          {t.assigned_agent_id && (
            <ToneBadge tone={mine ? 'ok' : 'mute'} style={{ fontSize: 8.5 }}>{mine ? 'Mine' : (t.assigned_agent_name || 'Assigned')}</ToneBadge>
          )}
          {t.linked_ticket_no && (
            <ToneBadge tone="info" style={{ fontSize: 8.5 }}>{t.linked_ticket_no}</ToneBadge>
          )}
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
  return (
    <div style={{ display: 'flex', justifyContent: isIn ? 'flex-start' : 'flex-end', marginBottom: 9 }}>
      <div style={{ maxWidth: '74%', padding: '8px 12px', borderRadius: 12,
        borderBottomLeftRadius: isIn ? 3 : 12, borderBottomRightRadius: isIn ? 12 : 3,
        background: isIn ? 'var(--surface)' : 'var(--accent-bg)',
        border: `1px solid ${isIn ? 'var(--border)' : 'var(--accent-bd, var(--border-2))'}` }}>
        {m.kind === 'template' && (
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--info-fg)', textTransform: 'uppercase',
            letterSpacing: '0.05em', marginBottom: 4 }}>Template · {m.template_name}</div>
        )}
        {m.media_url && (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 4, fontSize: 11, color: 'var(--accent)' }}>
            {m.kind === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}{m.media_filename || 'media'}
          </a>
        )}
        {m.body && <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>}
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
