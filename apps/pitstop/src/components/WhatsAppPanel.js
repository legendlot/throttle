'use client';
import { useEffect, useState } from 'react';
import { MessageCircle, Image as ImageIcon, FileText, Clock, ExternalLink } from 'lucide-react';
import { csopsGet } from '../lib/csopsFetch.js';
import { fmtIstShort } from '../lib/datetime.js';

const BITESPEED_BASE = 'https://chat.bitespeed.co';
function buildBiteSpeedDeepLink(thread) {
  if (!thread) return BITESPEED_BASE;
  const accountId = thread.provider_account_id;
  const convId    = thread.provider_thread_ref;
  if (accountId && convId) return `${BITESPEED_BASE}/app/accounts/${accountId}/conversations/${convId}`;
  return BITESPEED_BASE;
}

// Embedded WhatsApp panel for /queue/detail. Phase C: scaffolds the thread UI
// against the data model in store.cs_wa_threads / cs_wa_messages /
// cs_wa_templates. Outbound messages land as cs_wa_messages with
// status='queued' (provider not wired yet — Phase C2 will replace the stub).

export default function WhatsAppPanel({ ticket, session }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    if (!ticket?.id || !session) return;
    setLoading(true);
    try {
      const t = await csopsGet('getWaThread', { ticket_id: ticket.id }, session);
      setData(t);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-line */ }, [ticket?.id, session]);

  if (!ticket?.customer_phone) {
    return (
      <Card>
        <Header />
        <Empty message="Ticket has no customer phone — link a phone number to enable WhatsApp." />
      </Card>
    );
  }

  if (loading) return <Card><Header /><div style={{ padding: 24, color: 'var(--t3)', textAlign: 'center', fontSize: 13 }}>Loading thread…</div></Card>;
  if (error)   return <Card><Header /><div style={{ padding: 16, color: '#dc2626', fontSize: 12 }}>{error}</div></Card>;

  const msgs = data?.messages || [];
  const inWindow = !!data?.within_customer_window;

  return (
    <Card>
      <Header inWindow={inWindow} windowUntil={data?.thread?.customer_window_until} />

      {/* Read-only mirror banner — replaces the deceptive "scaffold" banner */}
      <div style={{
        padding: '8px 14px',
        background: 'rgba(59,130,246,0.10)',
        borderBottom: '1px solid var(--border-1)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--t2)',
      }}>
        <MessageCircle size={13} style={{ color: '#2563eb' }} />
        <span>
          Read-only mirror of the BiteSpeed conversation — reply in BiteSpeed to deliver to the customer. Two-way sync ships in Phase C2-B.
        </span>
      </div>

      {/* Thread messages */}
      <div style={{ padding: 12, maxHeight: 400, overflowY: 'auto', background: 'var(--surface-2)' }}>
        {msgs.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>
            No WhatsApp messages on this thread yet.
          </div>
        ) : msgs.map(m => <MessageRow key={m.id} m={m} />)}
      </div>

      {/* Footer: deep-link to BiteSpeed for replies */}
      <div style={{
        borderTop: '1px solid var(--border-1)', padding: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>
          {data?.thread?.provider_thread_ref
            ? <>Conversation #{data.thread.provider_thread_ref}</>
            : <>No BiteSpeed conversation linked yet</>}
        </span>
        <a
          href={buildBiteSpeedDeepLink(data?.thread)}
          target="_blank"
          rel="noreferrer"
          style={btnPrimary}
        >
          <ExternalLink size={13} />
          {data?.thread?.provider_thread_ref ? 'Reply in BiteSpeed' : 'Open BiteSpeed'}
        </a>
      </div>
    </Card>
  );
}

function Header({ inWindow, windowUntil }) {
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: '1px solid var(--border-1)',
      background: 'var(--surface-1)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <MessageCircle size={14} style={{ color: '#16a34a' }} />
        <strong style={{ fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          WhatsApp
        </strong>
      </div>
      {windowUntil && (
        <WindowPill inWindow={inWindow} until={windowUntil} />
      )}
    </div>
  );
}

function WindowPill({ inWindow, until }) {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) {
    return (
      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(148,163,184,0.15)', color: '#64748b', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <Clock size={11} /> Customer window closed
      </span>
    );
  }
  const hours = Math.floor(ms / 3_600_000);
  const mins  = Math.floor((ms % 3_600_000) / 60_000);
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(34,197,94,0.15)', color: '#16a34a', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <Clock size={11} /> {hours}h {mins}m left
    </span>
  );
}

function Empty({ message }) {
  return <div style={{ padding: 24, color: 'var(--t3)', textAlign: 'center', fontSize: 13 }}>{message}</div>;
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
  const isIn = m.direction === 'inbound';
  const queued = m.status === 'queued';
  const fmt = fmtIstShort;
  const ts = m.received_at || m.sent_at || m.created_at;

  return (
    <div style={{
      display: 'flex',
      justifyContent: isIn ? 'flex-start' : 'flex-end',
      marginBottom: 8,
    }}>
      <div style={{
        maxWidth: '75%',
        padding: '8px 12px',
        borderRadius: 10,
        background: isIn ? 'var(--surface-1)' : 'rgba(22,163,74,0.12)',
        border: `1px solid ${isIn ? 'var(--border-1)' : 'rgba(22,163,74,0.25)'}`,
      }}>
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
          <span>{fmt(ts)}</span>
          {!isIn && (
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

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer',
  fontSize: 13, textDecoration: 'none',
};
