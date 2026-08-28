'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  MessageCircle, Instagram, Mail, Facebook, Globe,
  Image as ImageIcon, FileText, Clock, ArrowRight, StickyNote,
} from 'lucide-react';
import { csopsGet } from '../lib/csopsFetch.js';
import { fmtIstShort } from '../lib/datetime.js';

// The ticket's conversation, on whichever channel raised it (Pruthvi, #bugs
// 1787900742.603819 — 2026-08-28). Replaces WhatsAppPanel, which mirrored a BiteSpeed
// thread and told the agent to go and reply there.
//
// Two reasons that panel had to go, and only the first was reported:
//  · BiteSpeed is gone. A migrated (Relay) thread has no `provider_thread_ref`, so its
//    "Reply in BiteSpeed" button degraded to the BiteSpeed home page and the banner sent
//    agents somewhere they cannot reply.
//  · It was also BLANK. It resolved by phone through a `waba_phone_number_id IS NULL`
//    filter that predates Relay — measured 2026-08-28, it found a thread on 120 of the
//    4,227 tickets raised in 30 days that carry a phone (2.8%), while 2,621 of those
//    tickets had a real linked conversation it rendered as empty.
//
// Replies happen in the inbox, which is the one surface that owns sending on every
// channel — so this panel is deliberately read-only and its job is to get the agent
// there in one click.

const CHANNEL = {
  whatsapp:  { label: 'WhatsApp',  Icon: MessageCircle, color: '#16a34a' },
  instagram: { label: 'Instagram', Icon: Instagram,     color: '#d946ef' },
  messenger: { label: 'Messenger', Icon: Facebook,      color: '#2563eb' },
  facebook:  { label: 'Facebook',  Icon: Facebook,      color: '#2563eb' },
  email:     { label: 'Email',     Icon: Mail,          color: '#f59e0b' },
  web:       { label: 'Web chat',  Icon: Globe,         color: '#0ea5e9' },
};
function channelOf(c) { return CHANNEL[String(c || '').toLowerCase()] || { label: 'Conversation', Icon: MessageCircle, color: 'var(--t2)' }; }

// trailingSlash:true in next.config — the un-slashed form costs a redirect on gh-pages.
const inboxHref = (id) => `/inbox/?thread=${encodeURIComponent(id)}`;

function threadName(t) {
  return t?.customer_handle || t?.external_user_id || t?.customer_phone || 'Conversation';
}

export default function ConversationPanel({ ticket, session }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    if (!ticket?.id || !session) return undefined;
    setLoading(true);
    csopsGet('getTicketThread', { ticket_id: ticket.id }, session)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ticket?.id, session]);

  const thread = data?.thread || null;
  const ch = channelOf(thread?.channel);

  if (loading) return <Card><Header ch={ch} /><Note>Loading conversation…</Note></Card>;
  if (error)   return <Card><Header ch={ch} /><div style={{ padding: 16, color: '#dc2626', fontSize: 12 }}>{error}</div></Card>;

  if (!thread) {
    return (
      <Card>
        <Header ch={ch} />
        <Note>
          {data?.reason === 'no_phone_or_email_on_ticket'
            ? 'This ticket has no phone or email, so no conversation can be matched to it.'
            : 'No conversation on any channel for this customer yet.'}
        </Note>
      </Card>
    );
  }

  const msgs = data?.messages || [];
  const others = (data?.threads || []).slice(1);
  const matchedBy = data?.matched_by;

  return (
    <Card>
      <Header ch={ch} thread={thread} inWindow={!!data?.within_customer_window} />

      {/* A matched thread is the same customer, not a bound conversation. Say which it is —
          an agent acting on "linked" when it is only "matched" is acting on an assumption. */}
      {matchedBy !== 'link' && (
        <div style={bannerStyle}>
          <MessageCircle size={13} style={{ color: 'var(--t3)' }} />
          <span>
            Matched by {matchedBy === 'email' ? 'email address' : 'phone number'} — this conversation
            is not linked to the ticket. Link it from the inbox to bind them.
          </span>
        </div>
      )}

      <div style={{ padding: 12, maxHeight: 400, overflowY: 'auto', background: 'var(--surface-2)' }}>
        {msgs.length === 0
          ? <Note>No messages on this conversation yet.</Note>
          : msgs.map((m) => <MessageRow key={m.id} m={m} />)}
      </div>

      <div style={{
        borderTop: '1px solid var(--border-1)', padding: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>
          {threadName(thread)}
          {thread.thread_state ? ` · ${thread.thread_state}` : ''}
          {thread.assigned_agent_name ? ` · ${thread.assigned_agent_name}` : ' · unassigned'}
        </span>
        <Link href={inboxHref(thread.id)} style={btnPrimary}>
          Open in inbox <ArrowRight size={13} />
        </Link>
      </div>

      {others.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-1)', padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--t3)' }}>Also on this ticket:</span>
          {others.map((t) => {
            const c = channelOf(t.channel);
            return (
              <Link key={t.id} href={inboxHref(t.id)} style={chipLink}>
                <c.Icon size={11} style={{ color: c.color }} /> {c.label}
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Header({ ch, thread, inWindow }) {
  const Icon = ch.Icon;
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: '1px solid var(--border-1)',
      background: 'var(--surface-1)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={14} style={{ color: ch.color }} />
        <strong style={{ fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          {ch.label}
        </strong>
      </div>
      {thread?.customer_window_until && (
        <WindowPill inWindow={inWindow} until={thread.customer_window_until} />
      )}
    </div>
  );
}

function WindowPill({ inWindow, until }) {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0 || !inWindow) {
    return (
      <span style={{ ...pill, background: 'rgba(148,163,184,0.15)', color: '#64748b' }}>
        <Clock size={11} /> Customer window closed
      </span>
    );
  }
  const hours = Math.floor(ms / 3_600_000);
  const mins  = Math.floor((ms % 3_600_000) / 60_000);
  return (
    <span style={{ ...pill, background: 'rgba(34,197,94,0.15)', color: '#16a34a' }}>
      <Clock size={11} /> {hours}h {mins}m left
    </span>
  );
}

function Note({ children }) {
  return <div style={{ padding: 24, color: 'var(--t3)', textAlign: 'center', fontSize: 13 }}>{children}</div>;
}

function Card({ children }) {
  return (
    <section style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border-1)',
      borderRadius: 8,
      overflow: 'hidden',
      marginTop: 16,
    }}>{children}</section>
  );
}

function MessageRow({ m }) {
  const isNote = !!m.is_internal;
  const isIn = m.direction === 'inbound';
  const queued = m.status === 'queued';
  const ts = m.received_at || m.sent_at || m.created_at;

  return (
    <div style={{ display: 'flex', justifyContent: isNote ? 'center' : (isIn ? 'flex-start' : 'flex-end'), marginBottom: 8 }}>
      <div style={{
        maxWidth: '75%',
        padding: '8px 12px',
        borderRadius: 10,
        background: isNote ? 'rgba(245,158,11,0.10)' : (isIn ? 'var(--surface-1)' : 'rgba(22,163,74,0.12)'),
        border: `1px solid ${isNote ? 'rgba(245,158,11,0.30)' : (isIn ? 'var(--border-1)' : 'rgba(22,163,74,0.25)')}`,
      }}>
        {isNote && (
          <div style={{ fontSize: 10, fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <StickyNote size={10} /> Internal note{m.sent_by_name ? ` · ${m.sent_by_name}` : ''}
          </div>
        )}
        {m.kind === 'template' && (
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Template · {m.template_name}
          </div>
        )}
        {m.media_url && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11, color: 'var(--t3)' }}>
            {m.kind === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
            <a href={m.media_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{m.media_filename || 'media'}</a>
          </div>
        )}
        {m.body && (
          <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>{m.body}</div>
        )}
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--t3)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{fmtIstShort(ts)}</span>
          {!isIn && !isNote && (
            <span style={{
              padding: '0px 6px', borderRadius: 999, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              background: queued ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)',
              color: queued ? '#d97706' : '#16a34a',
            }}>{m.status || 'queued'}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const pill = {
  fontSize: 11, padding: '2px 8px', borderRadius: 999,
  display: 'inline-flex', gap: 4, alignItems: 'center',
};

const bannerStyle = {
  padding: '8px 14px',
  background: 'var(--surface-2)',
  borderBottom: '1px solid var(--border-1)',
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 11, color: 'var(--t2)',
};

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer',
  fontSize: 13, textDecoration: 'none',
};

const chipLink = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '3px 8px', borderRadius: 999, fontSize: 11,
  border: '1px solid var(--border-1)', color: 'var(--t2)',
  textDecoration: 'none', background: 'var(--surface-2)',
};
