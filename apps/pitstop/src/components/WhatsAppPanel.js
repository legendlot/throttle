'use client';
import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Send, Image as ImageIcon, FileText, Clock, AlertTriangle, ChevronDown } from 'lucide-react';
import { useEscapeClose } from '@throttle/ui';
import { csopsGet, csopsPost } from '../lib/csopsFetch.js';

// Embedded WhatsApp panel for /queue/detail. Phase C: scaffolds the thread UI
// against the data model in store.cs_wa_threads / cs_wa_messages /
// cs_wa_templates. Outbound messages land as cs_wa_messages with
// status='queued' (provider not wired yet — Phase C2 will replace the stub).

export default function WhatsAppPanel({ ticket, session }) {
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  async function load() {
    if (!ticket?.id || !session) return;
    setLoading(true);
    try {
      const [t, tpls] = await Promise.all([
        csopsGet('getWaThread', { ticket_id: ticket.id }, session),
        csopsGet('getWaTemplates', {}, session),
      ]);
      setData(t);
      setTemplates(tpls || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-line */ }, [ticket?.id, session]);

  async function sendReply(e) {
    e?.preventDefault();
    if (!replyText.trim()) return;
    setSending(true);
    try {
      await csopsPost('sendWaMessage', { ticket_id: ticket.id, kind: 'text', body: replyText.trim() }, session);
      setReplyText('');
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setSending(false);
    }
  }

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

      {/* Provider-not-wired banner */}
      <div style={{
        padding: '8px 14px',
        background: 'rgba(245,158,11,0.10)',
        borderBottom: '1px solid var(--border-1)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: '#92400e',
      }}>
        <AlertTriangle size={13} />
        <span>
          Phase C scaffold — outbound messages are recorded but not yet delivered. Provider integration ships in Phase C2.
        </span>
      </div>

      {/* Thread messages */}
      <div style={{ padding: 12, maxHeight: 400, overflowY: 'auto', background: 'var(--surface-2)' }}>
        {msgs.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: 24 }}>
            No messages yet. Use "Send Template" to open a conversation.
          </div>
        ) : msgs.map(m => <MessageRow key={m.id} m={m} />)}
      </div>

      {/* Composer */}
      <div style={{ borderTop: '1px solid var(--border-1)', padding: 12 }}>
        {inWindow ? (
          <form onSubmit={sendReply} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              placeholder="Free-text reply (within 24h customer window)…"
              style={input}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !replyText.trim()} style={btnPrimary}>
              <Send size={13} /> {sending ? 'Queueing…' : 'Queue'}
            </button>
            <button type="button" onClick={() => setShowTemplateModal(true)} style={btnSecondary}>
              Template
            </button>
          </form>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>
              Outside the 24h customer-initiated window — only utility templates can be sent.
            </span>
            <button onClick={() => setShowTemplateModal(true)} style={btnPrimary}>
              <Send size={13} /> Send Template
            </button>
          </div>
        )}
      </div>

      {showTemplateModal && (
        <TemplateModal
          templates={templates}
          ticket={ticket}
          session={session}
          onClose={() => setShowTemplateModal(false)}
          onSent={() => { setShowTemplateModal(false); load(); }}
        />
      )}
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
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
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

function TemplateModal({ templates, ticket, session, onClose, onSent }) {
  const [picked, setPicked] = useState(templates[0] || null);
  const [params, setParams] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEscapeClose(true, onClose);

  const preview = useMemo(() => {
    if (!picked) return '';
    let body = picked.body;
    for (let i = 1; i <= (picked.placeholder_count || 0); i++) {
      body = body.split(`{{${i}}}`).join(params[i] || `{{${i}}}`);
    }
    return body;
  }, [picked, params]);

  async function send(e) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true); setErr(null);
    try {
      const template_params = [];
      for (let i = 1; i <= (picked.placeholder_count || 0); i++) {
        template_params.push({ index: i, value: params[i] || '' });
      }
      await csopsPost('sendWaMessage', {
        ticket_id: ticket.id,
        kind: 'template',
        template_name: picked.name,
        template_params,
      }, session);
      onSent();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <form onClick={e => e.stopPropagation()} onSubmit={send} style={{
        background: 'var(--surface-1)', border: '1px solid var(--border-1)',
        borderRadius: 10, padding: 24, width: 540, maxWidth: '94vw',
      }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Send WhatsApp Template</h2>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Template</span>
          <select value={picked?.name || ''} onChange={e => { setPicked(templates.find(t => t.name === e.target.value)); setParams({}); }} style={input}>
            {templates.map(t => (
              <option key={t.name} value={t.name}>{t.display_label} ({t.category})</option>
            ))}
          </select>
        </label>

        {picked?.placeholder_count > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Placeholders ({picked.placeholder_count})
            </div>
            {Array.from({ length: picked.placeholder_count }, (_, i) => i + 1).map(n => (
              <input key={n} placeholder={`{{${n}}}`} value={params[n] || ''}
                onChange={e => setParams({ ...params, [n]: e.target.value })}
                style={{ ...input, marginBottom: 6 }} />
            ))}
          </div>
        )}

        <div style={{ padding: 10, background: 'var(--surface-2)', borderRadius: 6, fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap', marginBottom: 12, border: '1px solid var(--border-1)' }}>
          {preview}
        </div>

        {err && <div style={{ padding: 8, background: 'rgba(239,68,68,0.10)', color: '#dc2626', borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={busy} style={btnPrimary}>
            <Send size={13} /> {busy ? 'Queueing…' : 'Queue Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

const input = { width: '100%', padding: '7px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 5, fontSize: 13, color: 'var(--t1)', boxSizing: 'border-box' };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13 };
const btnSecondary = { padding: '7px 14px', background: 'transparent', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--t2)', cursor: 'pointer', fontSize: 13 };
