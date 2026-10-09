'use client';
import { useEffect, useState, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Send, Star, Lock, FileText, ExternalLink } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import { istToday } from '../../../../lib/istDate.js';
import {
  CHANNEL_LABELS, CHANNEL_ICONS, STATUS_LABELS, STATUS_VALUES,
} from '../../../../lib/connects.js';
import { Card, SectionTitle, Avatar, FilterSelect } from '../../../../components/ui/index.js';

function shortTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function clockTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

// Day key + chip label for the centred date chips (e.g. "TUE 07 OCT"), on the IST calendar.
function dayKey(iso) {
  return iso ? istToday(new Date(iso).getTime()) : '';
}
function dayLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/,/g, '').toUpperCase();
}

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const metaStyle = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' };

function DateChip({ iso }) {
  return (
    <div style={{
      alignSelf: 'center', ...metaStyle, padding: '4px 10px', borderRadius: 99, background: 'var(--bg)',
    }}>{dayLabel(iso)}</div>
  );
}

function Bubble({ m }) {
  // Internal note (e.g. the "↪ Transferred to Influencer team" handoff) — amber, dashed, centered.
  if (m.is_internal || m.kind === 'note') {
    return (
      <div className="ig-pop" style={{ alignSelf: 'center', maxWidth: '86%' }}>
        <div style={{
          padding: '10px 14px', borderRadius: 14,
          background: 'var(--state-warning-bg)', border: '1px dashed var(--state-warning-fg)',
        }}>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, color: 'var(--state-warning-fg)',
            textTransform: 'uppercase', letterSpacing: 'var(--tracking-mid)', marginBottom: 4,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <Lock size={11} /> Internal note{m.sent_by_name ? ` · ${m.sent_by_name}` : ''}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
        </div>
        <div style={{ ...metaStyle, marginTop: 4, textAlign: 'center' }}>{clockTime(m.created_at)}</div>
      </div>
    );
  }
  const isIn = m.direction === 'inbound';
  // Email HTML — render in a sandboxed iframe (no scripts / no same-origin) so
  // arbitrary customer markup can't run or escape.
  const emailHtml = m.body_html ? m.body_html : null;
  const isImage = m.kind === 'image' && m.media_url;
  const side = isIn ? 'flex-start' : 'flex-end';
  const fg = isIn ? 'var(--text-1)' : 'var(--accent-fg)';
  return (
    <div className="ig-pop" style={{
      alignSelf: side, alignItems: side, display: 'flex', flexDirection: 'column', gap: 4,
      maxWidth: emailHtml ? '92%' : '70%', width: emailHtml ? 560 : undefined, minWidth: 0,
    }}>
      <div style={{
        padding: emailHtml ? 8 : '10px 14px', borderRadius: 16, maxWidth: '100%', boxSizing: 'border-box',
        width: emailHtml ? '100%' : undefined,
        background: emailHtml ? 'var(--surface-raised)' : isIn ? 'var(--chip-neutral)' : 'var(--accent)',
        border: emailHtml ? '1px solid var(--border-2)' : 'none',
        color: emailHtml ? 'var(--text-1)' : fg, fontSize: 14, lineHeight: 1.45,
      }}>
        {m.media_url && (isImage ? (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginBottom: m.body ? 6 : 0 }}>
            <img src={m.media_url} alt={m.media_filename || 'image'}
              style={{ maxWidth: '100%', width: 240, maxHeight: 240, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
          </a>
        ) : (
          <a href={m.media_url} target="_blank" rel="noreferrer" style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12, fontWeight: 600,
            color: isIn || emailHtml ? 'var(--accent)' : fg, textDecoration: isIn || emailHtml ? 'none' : 'underline',
            wordBreak: 'break-all',
          }}>
            <FileText size={13} style={{ flexShrink: 0 }} />{m.media_filename || 'media'}
          </a>
        ))}
        {emailHtml ? (
          <iframe sandbox="" srcDoc={emailHtml} title="email body"
            style={{
              width: '100%', minHeight: 90, maxHeight: 460, border: 'none',
              background: '#fff', borderRadius: 10, display: 'block',
            }} />
        ) : m.body ? (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
        ) : null}
      </div>
      <span style={metaStyle}>
        {clockTime(m.created_at)}{!isIn && m.sent_by_name ? ` · ${m.sent_by_name}` : ''}
      </span>
    </div>
  );
}

function KV({ label, children }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14,
    }}>
      <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
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
    // Keyed on the newest message, not the count: a thread at the 500-message cap keeps its length.
  }, [data?.messages?.length, data?.messages?.[data.messages.length - 1]?.id]);

  async function send() {
    if (sending || !text.trim()) return;
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
      toast(res?.already_promoted ? 'Already promoted'
        : res?.matched ? `Linked to existing ${inf?.influencer_code || ''} (same ${res.matched.on.join(' + ')})`
          + (res.matched.candidates > 1 ? ` — ${res.matched.candidates - 1} other match${res.matched.candidates > 2 ? 'es' : ''}, check for duplicates` : '')
        : `Promoted → ${inf?.influencer_code || ''}`, 'success');
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
    if (!confirm('Send this conversation back to the Pitstop CS team? It leaves Connects and goes back to their inbox.')) return;
    setReturning(true);
    try {
      await ignitionopsPost('returnConnect', { thread_id: threadId }, session);
      toast('Sent back to Pitstop CS', 'success');
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

  const channelLabel = CHANNEL_LABELS[t.channel] || t.channel || '';
  const ChannelIcon = CHANNEL_ICONS[t.channel];
  const handleLine = t.customer_handle && t.customer_handle !== who ? t.customer_handle : null;
  const sendDisabled = sending || !text.trim();

  // Date chips: one per calendar day, before that day's first message.
  const items = [];
  let lastDay = '';
  messages.forEach(m => {
    const k = dayKey(m.created_at);
    if (k && k !== lastDay) { items.push(<DateChip key={`d-${k}`} iso={m.created_at} />); lastDay = k; }
    items.push(<Bubble key={m.id} m={m} />);
  });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      {/* Thread card */}
      <Card padding="0" className="ig-up" style={{
        flex: '999 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
        }}>
          <button onClick={() => router.push('/connects/')} style={iconBtn} className="ig-ghost-btn" title="Back to Connects">
            <ArrowLeft size={16} />
          </button>
          <Avatar name={who} seed={threadId} size={40} />
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <h1 style={{
              margin: 0, fontFamily: 'var(--font-cond)', fontSize: 18, fontWeight: 700, lineHeight: 1.25,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {who}
            </h1>
            <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {ChannelIcon && <ChannelIcon size={12} />}
              <span>{channelLabel}</span>
              {handleLine && <span>· {handleLine}</span>}
              {t.ignition_transferred_at && <span>· transferred by Pitstop CS {relTime(t.ignition_transferred_at)}</span>}
            </div>
          </div>
          <button
            onClick={returnToPitstop}
            disabled={returning}
            className="ig-ghost-btn"
            title="Send this conversation back to the Pitstop CS team"
            style={{
              height: 36, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
              borderRadius: 10, border: '1px solid var(--border-3)', background: 'transparent',
              color: 'var(--text-1)', font: 'inherit', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              cursor: returning ? 'not-allowed' : 'pointer', opacity: returning ? 0.5 : 1,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--state-success)' }} />
            {returning ? 'Sending back…' : 'Send back to Pitstop'}
          </button>
        </div>

        {/* Handoff banner */}
        {connect.thread_id && (
          <div style={{
            margin: '12px 18px 0', padding: '10px 14px', borderRadius: 'var(--r-row)',
            background: 'var(--state-warning-bg)', border: '1px dashed var(--state-warning-fg)',
            color: 'var(--text-2)', fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <Lock size={13} style={{ color: 'var(--state-warning-fg)', flexShrink: 0, marginTop: 2 }} />
            <span>
              Transferred from Pitstop CS{t.ignition_transferred_at ? ` · ${shortTime(t.ignition_transferred_at)}` : ''}.
              Channel ownership stays with Pitstop — your replies go out through their channel.
            </span>
          </div>
        )}

        {/* Email subject header */}
        {isEmail && t.subject && (
          <div style={{
            margin: '12px 18px 0', padding: '8px 14px', borderRadius: 'var(--r-ctl)',
            background: 'var(--input)', border: '1px solid var(--border-2)',
            fontSize: 14, color: 'var(--text-1)', wordBreak: 'break-word',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', color: 'var(--text-4)', fontSize: 11, textTransform: 'uppercase',
              letterSpacing: 'var(--tracking-wide)', marginRight: 8,
            }}>Subject</span>
            {t.subject}
          </div>
        )}

        {/* Conversation */}
        <div ref={scrollRef} style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: 20,
          minHeight: 240, maxHeight: '58vh', overflowY: 'auto',
        }}>
          {messages.length === 0 ? (
            <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 20 }}>No messages yet.</div>
          ) : items}
        </div>

        {/* Composer — multi-line; sends on Cmd/Ctrl+Enter only (plain Enter = newline). */}
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
          {composerDisabled ? (
            <div style={{
              color: 'var(--state-warning-fg)', fontSize: 13, padding: '8px 0',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Lock size={13} style={{ flexShrink: 0 }} /> {disabledReason}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) send(); }}
                  placeholder={`Reply on ${channelLabel || 'this channel'}… (Cmd/Ctrl+Enter to send)`}
                  rows={2}
                  style={{
                    flex: 1, minWidth: 0, minHeight: 44, boxSizing: 'border-box', resize: 'vertical',
                    background: 'var(--input)', color: 'var(--text-1)',
                    border: '1px solid var(--border-2)', borderRadius: 'var(--r-btn)',
                    padding: '11px 14px', font: 'inherit', fontSize: 14, lineHeight: 1.45, outline: 'none',
                  }}
                />
                <button
                  onClick={send}
                  disabled={sendDisabled}
                  className={sendDisabled ? undefined : 'ig-cta'}
                  style={{
                    height: 44, padding: '0 18px', flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'var(--accent)', color: 'var(--accent-fg)',
                    border: 'none', borderRadius: 'var(--r-btn)',
                    font: 'inherit', fontSize: 14, fontWeight: 700,
                    cursor: sendDisabled ? 'not-allowed' : 'pointer',
                    opacity: sendDisabled ? 0.5 : 1,
                  }}
                >
                  <Send size={14} /> {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
              {sendErr && (
                <div style={{ color: 'var(--state-error-fg)', fontSize: 13, marginTop: 8 }}>{sendErr}</div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Right column */}
      <aside style={{ flex: '1 1 340px', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card className="ig-up" style={{ animationDelay: '80ms' }}>
          <SectionTitle size={15} style={{ marginBottom: 4 }}>Link to influencer</SectionTitle>
          {promoted && influencer ? (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>Linked to</div>
              <a
                href={`/influencers/detail/?id=${influencer.id}`}
                className="ig-ghost-btn"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42,
                  borderRadius: 'var(--r-btn)', border: '1px solid var(--border-3)',
                  fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--accent)',
                }}
              >
                <Star size={14} /> {influencer.influencer_code} <ExternalLink size={13} />
              </a>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
                Not linked yet. Creates a new influencer record from this thread’s handle / phone / email.
              </div>
              <button
                onClick={promote}
                disabled={promoting}
                className={promoting ? undefined : 'ig-cta'}
                style={{
                  width: '100%', height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  borderRadius: 'var(--r-btn)', border: 'none', background: 'var(--text-1)', color: 'var(--bg)',
                  font: 'inherit', fontSize: 14, fontWeight: 700,
                  cursor: promoting ? 'not-allowed' : 'pointer', opacity: promoting ? 0.5 : 1,
                }}
              >
                <Star size={14} /> {promoting ? 'Creating…' : 'Create influencer'}
              </button>
            </>
          )}
        </Card>

        <Card className="ig-up" style={{ animationDelay: '140ms' }}>
          <SectionTitle size={15} style={{ marginBottom: 8 }}>Details</SectionTitle>
          <KV label="Channel">{channelLabel || '—'}</KV>
          {t.customer_handle && <KV label="Handle">{t.customer_handle}</KV>}
          {t.customer_phone && <KV label="Phone"><span style={{ fontFamily: 'var(--font-mono)' }}>{t.customer_phone}</span></KV>}
          {t.customer_email && <KV label="Email">{t.customer_email}</KV>}
          {t.ignition_transferred_at && <KV label="Transferred">{shortTime(t.ignition_transferred_at)}</KV>}
          {!isEmail && <KV label="Reply window">{inWindow
            ? <span style={{ color: 'var(--state-success-fg)' }}>Open</span>
            : <span style={{ color: 'var(--state-warning-fg)' }}>Closed</span>}</KV>}
          <KV label="Status">
            <FilterSelect value={connect.status || 'new'} onChange={e => changeStatus(e.target.value)} width={140} style={{ height: 34 }}>
              {/* "Promoted" means an influencer is linked — reached only through Promote, never picked bare. */}
              {STATUS_VALUES.map(s => <option key={s} value={s} disabled={s === 'promoted' && !connect.influencer_id}>{STATUS_LABELS[s] || s}</option>)}
            </FilterSelect>
          </KV>
        </Card>
      </aside>
    </div>
  );
}

const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: 34, height: 34, background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border-2)', borderRadius: 10, cursor: 'pointer',
};
