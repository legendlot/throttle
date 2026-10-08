'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useListNav } from '@throttle/ui';
import { Segmented, FilterSelect, Avatar, Banner } from '../../../components/ui/index.js';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import {
  CHANNEL_LABELS, CHANNEL_ICONS, CHANNEL_PALETTE,
  STATUS_LABELS, STATUS_VALUES,
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

// Pill colours; the D5 labels come from lib/connects.js STATUS_LABELS (shared with the detail page).
const STATUS_PILL = {
  new:      { fg: '#F2CD1A',   bg: 'rgba(242,205,26,.14)' },
  working:  { fg: '#8ea2ff',   bg: 'rgba(33,60,226,.22)' },
  promoted: { fg: '#4ade80',   bg: 'rgba(34,197,94,.14)' },
  closed:   { fg: 'var(--text-3)', bg: 'var(--surface-2)' },
};

function StatusBadge({ status }) {
  const pal = { label: STATUS_LABELS[status] || status, ...(STATUS_PILL[status] || { fg: 'var(--text-3)', bg: 'var(--surface-2)' }) };
  return (
    <span style={{
      justifySelf: 'start', fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 99,
      color: pal.fg, background: pal.bg, whiteSpace: 'nowrap',
    }}>
      {pal.label}
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
  const [error, setError] = useState(null);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/connects/detail/?thread_id=${r.thread_id}`);
  });

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    setError(null);
    ignitionopsGet('getConnects', { channel, status }, session)
      .then(r => setRows(r.connects || []))
      .catch(e => { setError(e.message || String(e)); setRows([]); })
      .finally(() => setLoading(false));
  }, [channel, status, session]);

  // W6 (partial): client-side count over the rows currently loaded (current channel/status filter).
  const newCount = rows.filter(r => r.status === 'new').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>
            Work · Transferred from Pitstop CS
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6, color: 'var(--text-1)' }}>
            Connects
            {!loading && newCount > 0 && (
              <span title="Counted over the conversations loaded below" style={{ fontSize: 18, color: '#F2CD1A', verticalAlign: 'middle', marginLeft: 10 }}>
                {/* the bridge returns the latest 200 threads — don't present a partial count as the total */}
                {newCount} new{rows.length >= 200 ? ` in latest ${rows.length}` : ''}
              </span>
            )}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterSelect value={status} onChange={e => setStatus(e.target.value)} width={160}>
            <option value="all">All statuses</option>
            {STATUS_VALUES.map(s => <option key={s} value={s}>{STATUS_LABELS[s] || s}</option>)}
          </FilterSelect>
          <Segmented options={CHANNEL_TABS.map(t => ({ value: t.id, label: t.label }))} value={channel} onChange={setChannel} />
        </div>
      </div>

      {error && <Banner tone="error" lead="Couldn’t load Connects:">{error}</Banner>}

      {loading ? <Spinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }}>
              No transferred conversations
            </div>
          )}
          {rows.map((r, i) => {
            const who = r.customer_handle || r.customer_phone || r.customer_email || '—';
            const preview = r.last_message?.body || (r.subject ? r.subject : '');
            const Icon = CHANNEL_ICONS[r.channel];
            const pal = CHANNEL_PALETTE[r.channel];
            return (
              <div key={r.thread_id}
                className={`ig-row${focusedIdx === i ? ' ig-row-focus' : ''}`}
                onClick={() => router.push(`/connects/detail/?thread_id=${r.thread_id}`)}
                onMouseEnter={() => setFocusedIdx(i)}
                style={{
                  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 14px', cursor: 'pointer',
                  padding: '12px 18px 12px 0', background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 14, overflow: 'hidden',
                }}
              >
                <span style={{ width: 6, height: 42, borderRadius: '0 4px 4px 0', flexShrink: 0, background: r.status === 'new' ? '#F2CD1A' : 'transparent' }} />
                <Avatar name={who} seed={r.thread_id} size={42} />
                <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-1)' }}>{who}</span>
                    {r.awaiting_reply && (
                      <span style={{
                        padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                        background: 'rgba(255,107,0,0.15)', color: '#FF6B00',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>Awaiting reply</span>
                    )}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: pal?.fg || 'var(--text-3)' }}>
                    {Icon && <Icon size={11} />} {CHANNEL_LABELS[r.channel] || r.channel}
                    {r.transferred_at && <span style={{ color: 'var(--text-4)' }}>· transferred {relTime(r.transferred_at)}</span>}
                  </span>
                </span>
                <span style={{ flex: '2 1 220px', minWidth: 0 }}>
                  <div style={{ color: 'var(--text-2)', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {preview || <span style={{ color: 'var(--text-4)' }}>—</span>}
                  </div>
                  {r.subject && r.channel === 'email' && r.last_message?.body && (
                    <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subject}</div>
                  )}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)', minWidth: 80 }}>{relTime(r.last_message_at)}</span>
                <span style={{ minWidth: 80, display: 'grid' }}><StatusBadge status={r.status} /></span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 80, color: r.influencer ? '#ff8a33' : 'var(--text-5)' }}>
                  {r.influencer ? r.influencer.influencer_code : 'Not linked'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
