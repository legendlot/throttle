'use client';
/* ════════════════════════════════════════════════════════════
   Pitstop "Volt" — Agent Inbox (S161).
   Cross-channel DM console over store.cs_wa_threads / cs_wa_messages.
   • Instagram + Facebook Messenger = two-way (reply via sendMetaMessage).
   • WhatsApp = read-only mirror (reply in BiteSpeed) until C2-B.
   • Link a thread to a ticket (IG/FB have no phone to auto-match on).
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Instagram, Facebook, MessageCircle, Send, Clock, ExternalLink, Link2, Image as ImageIcon, FileText } from 'lucide-react';
import { Panel, Tabs, ToneBadge, btnPrimary, btnGhost, inputStyle } from '../../../components/kit/index.js';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';

const CHANNELS = {
  instagram: { label: 'Instagram', color: '#E1306C', Glyph: Instagram, sendable: true },
  messenger: { label: 'Messenger', color: '#0084FF', Glyph: Facebook, sendable: true },
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', Glyph: MessageCircle, sendable: false },
};
const chanOf = (c) => CHANNELS[c] || { label: c || 'DM', color: 'var(--t3)', Glyph: MessageCircle, sendable: false };

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
  const { session, perms } = useAuth();
  const canManage = !!perms?.cs_ticket_manage;

  const [channel, setChannel] = useState('all');
  const [threads, setThreads] = useState([]);
  const [stats, setStats] = useState({
    instagram: { total: 0, awaiting: 0 },
    messenger: { total: 0, awaiting: 0 },
    whatsapp:  { total: 0, awaiting: null },
  });
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [convo, setConvo] = useState(null);          // { thread, messages, linked_ticket, within_customer_window }
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkVal, setLinkVal] = useState('');
  const scrollRef = useRef(null);

  // List is channel-scoped (WhatsApp has thousands of threads — fetching "all"
  // would bury the low-volume IG/FB threads). Tiles get their own stats call.
  const loadThreads = useCallback(async () => {
    if (!session) return;
    try {
      const d = await csopsGet('getMessagingThreads', channel === 'all' ? {} : { channel }, session);
      setThreads(d?.threads || []);
    } catch (e) { setErr(e.message); }
    finally { setLoadingList(false); }
  }, [session, channel]);

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

  // Thread list — load + 20s poll.
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

  // Open conversation — load on select + 15s poll.
  useEffect(() => {
    if (!selectedId) { setConvo(null); return undefined; }
    setLoadingConvo(true);
    loadConvo(selectedId);
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

  const tabs = [
    { id: 'all', label: 'All', count: allTotal },
    { id: 'instagram', label: 'Instagram', count: stats.instagram.total },
    { id: 'messenger', label: 'Messenger', count: stats.messenger.total },
    { id: 'whatsapp', label: 'WhatsApp', count: stats.whatsapp.total },
  ];

  async function send() {
    const t = text.trim();
    if (!t || !convo?.thread || sending) return;
    setSending(true); setErr(null);
    try {
      await csopsPost('sendMetaMessage', { thread_id: convo.thread.id, text: t }, session);
      setText('');
      await loadConvo(selectedId);
      loadThreads();
    } catch (e) { setErr(e.message); }
    finally { setSending(false); }
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
          <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>Conversations</span>
            <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{threads.length}</span>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingList ? (
              <Empty>Loading…</Empty>
            ) : threads.length === 0 ? (
              <Empty>No conversations yet.</Empty>
            ) : threads.map(t => (
              <ThreadRow key={t.id} t={t} active={t.id === selectedId} onClick={() => setSelectedId(t.id)} />
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
                  {!windowOpen && (
                    <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} /> Outside the 24h window — sends with a HUMAN_AGENT tag.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      value={text} onChange={e => setText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder={canManage ? 'Type a reply…  (Enter to send, Shift+Enter for newline)' : 'You need cs_ticket_manage to reply.'}
                      disabled={!canManage || sending} rows={2}
                      style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'var(--f-ui)' }} />
                    <button onClick={send} disabled={!canManage || sending || !text.trim()}
                      style={{ ...btnPrimary, opacity: (!canManage || sending || !text.trim()) ? 0.5 : 1 }}>
                      <Send size={13} /> {sending ? 'Sending' : 'Send'}
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
function ThreadRow({ t, active, onClick }) {
  const ch = chanOf(t.channel);
  const lm = t.last_message;
  const preview = lm ? (lm.body || (lm.kind && lm.kind !== 'text' ? `[${lm.kind}]` : '')) : '';
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
        {t.linked_ticket_no && (
          <div style={{ marginTop: 4 }}>
            <ToneBadge tone="info" style={{ fontSize: 8.5 }}>{t.linked_ticket_no}</ToneBadge>
          </div>
        )}
      </div>
    </button>
  );
}
function Bubble({ m, accent }) {
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
