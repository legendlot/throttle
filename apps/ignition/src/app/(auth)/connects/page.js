'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, useListNav } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import {
  CHANNEL_LABELS, CHANNEL_ICONS, CHANNEL_PALETTE,
  STATUS_LABELS, STATUS_PALETTE, STATUS_VALUES,
} from '../../../lib/connects.js';

const CHANNEL_TABS = [
  { id: 'all',       label: 'All' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'messenger', label: 'Messenger' },
  { id: 'whatsapp',  label: 'WhatsApp' },
  { id: 'email',     label: 'Email' },
];

function relTime(iso) {
  if (!iso) return '—';
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

function StatusBadge({ status }) {
  const pal = STATUS_PALETTE[status] || { fg: 'var(--text-3)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, background: pal.bg, color: pal.fg,
      fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export default function ConnectsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [channel, setChannel] = useState('all');
  const [status, setStatus] = useState('all');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/connects/detail/?thread_id=${r.thread_id}`);
  });

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getConnects', { channel, status }, session)
      .then(r => setRows(r.connects || []))
      .finally(() => setLoading(false));
  }, [channel, status, session]);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Connects
        </h1>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {CHANNEL_TABS.map(t => (
          <Chip key={t.id} active={channel === t.id} onClick={() => setChannel(t.id)}>{t.label}</Chip>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle(160)}>
          <option value="all">All statuses</option>
          {STATUS_VALUES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      {loading ? <Spinner /> : (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Customer</th>
                <th style={th}>Channel</th>
                <th style={th}>Last message</th>
                <th style={th}>Transferred</th>
                <th style={th}>Status</th>
                <th style={th}>Influencer</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No transferred conversations</td></tr>
              )}
              {rows.map((r, i) => {
                const who = r.customer_handle || r.customer_phone || r.customer_email || '—';
                const preview = r.last_message?.body || (r.subject ? r.subject : '');
                return (
                  <tr key={r.thread_id}
                    onClick={() => router.push(`/connects/detail/?thread_id=${r.thread_id}`)}
                    style={{
                      cursor: 'pointer', borderTop: '1px solid var(--border)',
                      background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                      outline: focusedIdx === i ? '2px solid #FF6B00' : 'none', outlineOffset: '-2px',
                    }}
                    onMouseEnter={() => setFocusedIdx(i)}
                  >
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>{who}</span>
                        {r.awaiting_reply && (
                          <span style={{
                            padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                            background: 'rgba(255,107,0,0.15)', color: '#FF6B00',
                            textTransform: 'uppercase', letterSpacing: '0.04em',
                          }}>Awaiting reply</span>
                        )}
                      </div>
                      {r.subject && r.channel === 'email' && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{r.subject}</div>
                      )}
                    </td>
                    <td style={td}><ChannelBadge channel={r.channel} /></td>
                    <td style={{ ...td, maxWidth: 320 }}>
                      <div style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                        {preview || <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{relTime(r.last_message_at)}</div>
                    </td>
                    <td style={td}>{relTime(r.transferred_at)}</td>
                    <td style={td}><StatusBadge status={r.status} /></td>
                    <td style={td}>
                      {r.influencer
                        ? <span style={{ color: 'var(--state-success-fg)', fontWeight: 600 }}>{r.influencer.influencer_code}</span>
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
function inputStyle(w) {
  return {
    background: 'var(--surface-2)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
    width: w,
  };
}
