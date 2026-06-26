'use client';
import { useEffect, useState, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Send, Star, Lock, FileText, ExternalLink } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import {
  CHANNEL_LABELS, CHANNEL_ICONS, CHANNEL_PALETTE,
  STATUS_LABELS, STATUS_PALETTE, STATUS_VALUES,
} from '../../../../lib/connects.js';

function shortTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function ChannelBadge({ channel }) {
  const Icon = CHANNEL_ICONS[channel];
  const pal = CHANNEL_PALETTE[channel] || { fg: 'var(--text-3)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999, background: pal.bg, color: pal.fg,
      fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
    }}>
      {Icon && <Icon size={11} />} {CHANNEL_LABELS[channel] || channel}
    </span>
  );
}

function Bubble({ m }) {
  // Internal note (e.g. the "↪ Transferred to Influencer team" handoff) — amber, dashed, centered.
  if (m.is_internal || m.kind === 'note') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 9 }}>
        <div style={{
          maxWidth: '86%', padding: '8px 12px', borderRadius: 10,
          background: 'var(--state-warning-bg)', border: '1px dashed var(--state-warning-fg)',
        }}>
          <div style={{
            fontSize: 9.5, fontWeight: 700, color: 'var(--state-warning-fg)', textTransform: 'uppercase',
            letterSpacing: '0.05em', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <Lock size={10} /> Internal note{m.sent_by_name ? ` · ${m.sent_by_name}` : ''}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
          <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--text-3)', textAlign: 'right' }}>{shortTime(m.created_at)}</div>
        </div>
      </div>
    );
  }
  const isIn = m.direction === 'inbound';
  // Email HTML — render in a sandboxed iframe (no scripts / no same-origin) so
  // arbitrary customer markup can't run or escape.
  const emailHtml = m.body_html ? m.body_html : null;
  const isImage = m.kind === 'image' && m.media_url;
  return (
    <div style={{ display: 'flex', justifyContent: isIn ? 'flex-start' : 'flex-end', marginBottom: 9 }}>
      <div style={{
        maxWidth: emailHtml ? '92%' : '74%', padding: '8px 12px', borderRadius: 12,
        borderBottomLeftRadius: isIn ? 3 : 12, borderBottomRightRadius: isIn ? 12 : 3,
        background: isIn ? 'var(--surface)' : 'var(--accent-bg)',
        border: `1px solid ${isIn ? 'var(--border)' : 'var(--border-2)'}`,
      }}>
        {m.media_url && (isImage ? (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginBottom: m.body ? 6 : 2 }}>
            <img src={m.media_url} alt={m.media_filename || 'image'}
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, display: 'block' }} />
          </a>
        ) : (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11, color: 'var(--accent)',
          }}>
            <FileText size={12} />{m.media_filename || 'media'}
          </a>
        ))}
        {emailHtml ? (
          <iframe sandbox="" srcDoc={emailHtml} title="email body"
            style={{
              width: 'min(560px, 70vw)', minHeight: 90, maxHeight: 460, border: 'none',
              background: '#fff', borderRadius: 6, display: 'block',
            }} />
        ) : m.body ? (
          <div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
        ) : null}
        <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--text-3)', display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'flex-end' }}>
          {!isIn && m.sent_by_name && <span>{m.sent_by_name}</span>}
          <span>{shortTime(m.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

export default function ConnectDetailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const threadId = sp.get('thread_id');
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const [returning, setReturning] = useState(false);
  const scrollRef = useRef(null);

  function reload() {
    if (!session || !threadId) return;
    ignitionopsGet('getConnect', { thread_id: threadId }, session)
      .then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [threadId, session]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length]);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    setSendErr(null);
    try {
      await ignitionopsPost('replyConnect', { thread_id: threadId, text }, session);
      setText('');
      toast('Reply sent', 'success');
      reload();
    } catch (e) {
      setSendErr(e.message);
    } finally {
      setSending(false);
    }
  }

  async function promote() {
    setPromoting(true);
    try {
      const res = await ignitionopsPost('promoteConnect', { thread_id: threadId }, session);
      const inf = res?.influencer;
      toast(res?.already_promoted ? 'Already promoted' : `Promoted → ${inf?.influencer_code || ''}`, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setPromoting(false);
    }
  }

  async function changeStatus(status) {
    try {
      await ignitionopsPost('setConnectStatus', { thread_id: threadId, status }, session);
      toast(`Marked ${STATUS_LABELS[status] || status}`, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function returnToPitstop() {
    if (!confirm('Return this conversation to the Pitstop CS team? It leaves Connects and goes back to their inbox.')) return;
    setReturning(true);
    try {
      await ignitionopsPost('returnConnect', { thread_id: threadId }, session);
      toast('Returned to Pitstop CS', 'success');
      router.push('/connects/');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setReturning(false);
    }
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;

  const t = data.thread || {};
  const connect = data.connect || {};
  const influencer = data.influencer;
  const messages = data.messages || [];
  const isEmail = t.channel === 'email';
  const inWindow = !!data.within_customer_window;
  const who = t.customer_handle || t.customer_phone || (isEmail ? t.subject : '') || '—';
  const promoted = connect.status === 'promoted' || !!connect.influencer_id || !!influencer;

  // Composer gating: non-email channels need the 24h customer window open.
  const composerDisabled = !isEmail && !inWindow;
  const disabledReason = 'Outside the 24h reply window — wait for the customer to message again.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 920 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => router.push('/connects/')} style={iconBtn} title="Back to Connects">
          <ArrowLeft size={16} />
        </button>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 20, fontWeight: 700, letterSpacing: '0.03em' }}>
          {who}
        </h1>
        <ChannelBadge channel={t.channel} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={connect.status || 'new'}
            onChange={e => changeStatus(e.target.value)}
            style={{
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 12,
            }}
          >
            {STATUS_VALUES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <button
            onClick={returnToPitstop}
            disabled={returning}
            title="Send this conversation back to the Pitstop CS team"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', background: 'var(--surface-2)', color: 'var(--text-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12,
              cursor: returning ? 'not-allowed' : 'pointer', opacity: returning ? 0.5 : 1,
            }}
          >
            <ArrowLeft size={13} /> {returning ? 'Returning…' : 'Return to Pitstop'}
          </button>
          {promoted && influencer ? (
            <a
              href={`/influencers/detail/?id=${influencer.id}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', background: 'var(--state-success-bg)', color: 'var(--state-success-fg)',
                border: '1px solid var(--state-success-fg)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.04em', textDecoration: 'none',
              }}
            >
              <Star size={13} /> {influencer.influencer_code} <ExternalLink size={12} />
            </a>
          ) : (
            <button
              onClick={promote}
              disabled={promoting}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', background: '#FF6B00', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                cursor: promoting ? 'not-allowed' : 'pointer', opacity: promoting ? 0.5 : 1,
              }}
            >
              <Star size={13} /> {promoting ? 'Promoting…' : 'Promote to influencer'}
            </button>
          )}
        </div>
      </div>

      {/* Handoff banner */}
      {connect.thread_id && (
        <div style={{
          padding: '10px 14px', borderRadius: 'var(--radius-md)',
          background: 'var(--state-warning-bg)', border: '1px dashed var(--state-warning-fg)',
          color: 'var(--text-1)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Lock size={13} style={{ color: 'var(--state-warning-fg)' }} />
          Transferred from Pitstop CS{t.ignition_transferred_at ? ` · ${shortTime(t.ignition_transferred_at)}` : ''}.
          Channel ownership stays with Pitstop — your replies go out through their channel.
        </div>
      )}

      {/* Email subject header */}
      {isEmail && t.subject && (
        <div style={{
          padding: '8px 14px', borderRadius: 'var(--radius-md)',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-1)',
        }}>
          <span style={{ color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 8 }}>Subject</span>
          {t.subject}
        </div>
      )}

      {/* Conversation */}
      <div ref={scrollRef} style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 14,
        maxHeight: '58vh', overflowY: 'auto',
      }}>
        {messages.length === 0 ? (
          <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 20 }}>No messages yet.</div>
        ) : messages.map(m => <Bubble key={m.id} m={m} />)}
      </div>

      {/* Composer */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 12,
      }}>
        {composerDisabled ? (
          <div style={{
            color: 'var(--state-warning-fg)', fontSize: 12.5, padding: '8px 4px',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Lock size={13} /> {disabledReason}
          </div>
        ) : (
          <>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
              placeholder={isEmail ? 'Write a reply… (Cmd/Ctrl+Enter to send)' : 'Write a reply… (Cmd/Ctrl+Enter to send)'}
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: 'var(--surface-2)', color: 'var(--text-1)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
              }}
            />
            {sendErr && (
              <div style={{ color: 'var(--state-error-fg)', fontSize: 12, marginTop: 6 }}>{sendErr}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button
                onClick={send}
                disabled={sending || !text.trim()}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', background: '#FF6B00', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-sm)',
                  fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: (sending || !text.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (sending || !text.trim()) ? 0.5 : 1,
                }}
              >
                <Send size={13} /> {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 32, height: 32, background: 'var(--surface-2)', color: 'var(--text-1)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
};
