'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip } from '@throttle/ui';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../components/StageBadge.js';
import { titleish } from '../../../lib/productLabel.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function influencerLabel(e) {
  const i = e.influencer || {};
  return i.channel_name || i.person_name || i.influencer_code || '—';
}

export default function SchedulePage() {
  const { session } = useAuth();
  const router = useRouter();
  const [view, setView] = useState('calendar');
  const [anchor, setAnchor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = fmt(new Date(y, m, 1));
  const to = fmt(new Date(y, m + 1, 0));
  const todayStr = fmt(new Date());

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getSchedule', { from, to }, session)
      .then(r => setRows(r.engagements || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [from, to, session]);

  const byDay = useMemo(() => {
    const map = {};
    for (const e of rows) { if (e.effective_date) (map[e.effective_date] ||= []).push(e); }
    return map;
  }, [rows]);

  // Calendar grid cells: leading blanks for the first weekday + each day of month.
  const cells = useMemo(() => {
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < firstWeekday; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    return arr;
  }, [y, m]);

  function goMonth(delta) { setAnchor(new Date(y, m + delta, 1)); }
  function goToday() { const d = new Date(); setAnchor(new Date(d.getFullYear(), d.getMonth(), 1)); }

  return (
    <div style={{ maxWidth: 1280 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Schedule</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={() => goMonth(-1)} style={navBtn} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <span style={{ minWidth: 130, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-1)' }}>{MONTHS[m]} {y}</span>
          <button onClick={() => goMonth(1)} style={navBtn} aria-label="Next month"><ChevronRight size={16} /></button>
          <button onClick={goToday} style={{ ...navBtn, width: 'auto', padding: '0 10px', fontSize: 12 }}>Today</button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Chip active={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</Chip>
          <Chip active={view === 'list'} onClick={() => setView('list')}>List</Chip>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 14, marginBottom: 10, fontSize: 12, color: 'var(--text-3)' }}>
        <span><span style={dot('#FF6B00')} /> Posted</span>
        <span><span style={{ ...dot('transparent'), border: '1px solid var(--text-3)' }} /> Planned (expected)</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>{rows.length} in {MONTHS[m]}</span>
      </div>

      <ChasingList session={session} router={router} />

      {loading ? <Spinner /> : view === 'calendar' ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
            {WEEKDAYS.map(w => (
              <div key={w} style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--surface-2)', textAlign: 'left', fontWeight: 600 }}>{w}</div>
            ))}
            {cells.map((d, i) => {
              if (d === null) return <div key={`b${i}`} style={{ minHeight: 96, borderTop: '1px solid var(--border)', borderRight: (i % 7 !== 6) ? '1px solid var(--border)' : 'none', background: 'var(--surface-2)', opacity: 0.4 }} />;
              const key = `${y}-${pad(m + 1)}-${pad(d)}`;
              const items = byDay[key] || [];
              const isToday = key === todayStr;
              return (
                <div key={key} style={{ minHeight: 96, padding: 6, borderTop: '1px solid var(--border)', borderRight: (i % 7 !== 6) ? '1px solid var(--border)' : 'none', background: isToday ? 'rgba(255,107,0,0.06)' : 'transparent' }}>
                  <div style={{ fontSize: 11, color: isToday ? '#FF6B00' : 'var(--text-3)', fontWeight: isToday ? 700 : 500, marginBottom: 4 }}>{d}</div>
                  {items.slice(0, 4).map(e => (
                    <div key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                      title={`${e.engagement_no} · ${influencerLabel(e)}${e.product_code ? ` · ${titleish(e.product_code)}` : ''}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: 'var(--text-1)', padding: '2px 4px', borderRadius: 4, marginBottom: 2, background: 'var(--surface-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={dot(e.is_planned ? 'transparent' : '#FF6B00', e.is_planned)} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{influencerLabel(e)}</span>
                    </div>
                  ))}
                  {items.length > 4 && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>+{items.length - 4} more</div>}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Date</th><th style={th}>Deal</th><th style={th}>Influencer</th>
                <th style={th}>Product</th><th style={th}>Stage</th><th style={th}>When</th><th style={th}>Post</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>Nothing scheduled in {MONTHS[m]} {y}</td></tr>}
              {rows.map(e => (
                <tr key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)} style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{e.effective_date}</td>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{e.engagement_no}</span></td>
                  <td style={td}>{influencerLabel(e)}</td>
                  <td style={td}>{titleish(e.product_code) || '—'}</td>
                  <td style={td}><StageBadge stage={e.stage} /></td>
                  <td style={td}><span style={dot(e.is_planned ? 'transparent' : '#FF6B00', e.is_planned)} />{e.is_planned ? 'Planned' : 'Posted'}</td>
                  <td style={td}>
                    {e.video_link
                      ? <a href={e.video_link} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} style={{ color: '#FF6B00', display: 'inline-flex', alignItems: 'center', gap: 3 }}>View <ExternalLink size={12} /></a>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dot(bg, planned) {
  return {
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: bg, marginRight: 6, verticalAlign: 'middle', flexShrink: 0,
    border: planned ? '1px solid var(--text-3)' : 'none',
  };
}
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 28, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'var(--font-mono)' };
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };

// "Who is overdue to post" — the chasing list (S313). Merges Reann's two separate asks: the
// 10-day-no-post reminder (Batch B5) and the Delhivery-delivered follow-up. They are one nudge
// with two triggers, and keeping them separate would let both land on the same creator.
//
// ⚠️ It LISTS, it does not send. Nothing in Ignition can email a creator yet — the send path
// needs a Relay template and an influencer comms profile. Until then this is the worklist
// someone works by hand, which is strictly better than the nothing that was here before.
// Where the 10-day clock actually started. `history` is a STAGE-CLICK date, not a delivery — it
// keeps the bare "12d" it has always had, and only a real courier delivery gets to say
// "delivered". The team has to be able to tell the two apart without opening the deal.
function clockLabel(d) {
  const n = d.days_since;
  if (d.anchor_source === 'courier') return `delivered ${n}d ago`;
  if (d.anchor_source === 'delivered_date') return `delivered ${n}d ago (typed)`;
  if (d.anchor_source === 'shipping_date') return `shipped ${n}d ago (typed)`;
  return `${n}d`;
}

function ChasingList({ session, router }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!session) return;
    setFailed(false);
    ignitionopsGet('getPostReminderDue', { days: 10 }, session)
      .then(d => { setData(d); setFailed(false); })
      // S369: a failure and "nothing to chase" MUST NOT look the same. Both used to
      // `setData(null)` and the whole panel returned null, so a broken read rendered as an
      // empty, reassuring screen. That matters more since the worker now THROWS on a failed
      // engagement_history chunk instead of quietly aging deals from a missing anchor.
      .catch(() => { setData(null); setFailed(true); });
  }, [session]);
  const returned = data?.returned || [];
  const stuck = data?.stuck || [];
  const degraded = Number(data?.anchor_degraded || 0) > 0;
  const courierDown = data?.courier_degraded === true;
  const truncated = Number(data?.scan_truncated || 0);
  const notice = failed
    ? 'Chasing list unavailable — could not load post reminders. Nobody has been checked; reload before assuming there is nothing to chase.'
    // Truncation first when it happens: deals past the cap were never looked at, so they are
    // missing from EVERY panel below, not just the chasing count.
    : truncated ? `Only the first ${data.scan_cap} of ${truncated} candidate deals were checked — every panel below is incomplete. Raise the scan cap.`
    // Courier first: without it, parcels still in transit come BACK onto the list and the
    // stuck/returned panels read as empty. That is a wronger list than a few missing dates.
    : courierDown ? 'Courier status could not be loaded — parcels still in transit may be listed below, and the stuck and returned panels are not reliable.'
    : degraded ? 'Some deals could not be dated and are missing from the list below — treat it as incomplete.'
    : null;
  const Notice = () => (
    <div style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#FF6B00' }}>
      {notice}
    </div>
  );
  if (failed) return <Notice />;
  if (!data || (!data.count && !returned.length && !stuck.length)) return degraded ? <Notice /> : null;
  return (
    <>
    {notice && <Notice />}
    {data.count > 0 && (
    <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'left' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700 }}>{data.count}</span>
        <span>waiting to post 10+ days after delivery</span>
        {data.unreachable > 0 && (
          <span style={{ color: 'var(--text-3)' }}>· {data.unreachable} with no email on record</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', maxHeight: 320, overflowY: 'auto' }}>
          {data.due.map(d => (
            <div key={d.engagement_no}
              onClick={() => router.push(`/engagements/?search=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, cursor: 'pointer' }}>
              <span style={{ color: '#FF6B00', fontFamily: 'var(--font-mono)' }}>{d.engagement_no}</span>
              <span style={{ color: 'var(--text-1)' }}>{d.influencer}</span>
              <span style={{ color: 'var(--text-3)' }}>{clockLabel(d)}</span>
              {!d.email && <span style={{ color: 'var(--state-error-fg)' }}>no email</span>}
              {!d.has_tracking_link && <span style={{ color: 'var(--text-3)' }}>no link</span>}
            </div>
          ))}
        </div>
      )}
    </div>
    )}

    {/* Stuck in flight. Additive for the same reason `returned` is: these are excluded from the
        chasing list (rightly — the creator has nothing yet), and excluding them SILENTLY is how a
        parcel sat in transit for 50 days with nobody looking. Amber, not red: it is not lost yet. */}
    {stuck.length > 0 && (
      <div style={{ marginBottom: 12, border: '1px solid var(--state-warning)', borderRadius: 'var(--radius-md)', background: 'var(--state-warning-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-1)' }}>
          <span style={{ color: 'var(--state-warning-fg)', fontWeight: 700 }}>{stuck.length}</span>
          <span>parcel{stuck.length === 1 ? '' : 's'} still in flight after 14+ days — chase the courier, not the creator</span>
        </div>
        <div style={{ borderTop: '1px solid var(--state-warning)' }}>
          {stuck.map(d => (
            <div key={d.engagement_no}
              onClick={() => router.push(`/engagements/?search=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 12px', borderTop: '1px solid var(--state-warning)', fontSize: 12, cursor: 'pointer' }}>
              <span style={{ color: 'var(--state-warning-fg)', fontFamily: 'var(--font-mono)' }}>{d.engagement_no}</span>
              <span style={{ color: 'var(--text-1)' }}>{d.influencer}</span>
              <span style={{ color: 'var(--state-warning-fg)' }}>{d.lifecycle === 'out_for_delivery' ? 'out for delivery' : String(d.lifecycle || '').replace('_', ' ')}</span>
              <span style={{ color: 'var(--text-3)' }}>{d.days_since}d</span>
              {d.courier && <span style={{ color: 'var(--text-3)' }}>{d.courier}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{d.stage}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {returned.length > 0 && (
      <div style={{ marginBottom: 12, border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)', background: 'var(--state-error-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-1)' }}>
          <span style={{ color: 'var(--state-error-fg)', fontWeight: 700 }}>{returned.length}</span>
          <span>parcel{returned.length === 1 ? '' : 's'} came back — the creator never received the product, so do not chase</span>
        </div>
        <div style={{ borderTop: '1px solid var(--state-error)' }}>
          {returned.map(d => (
            <div key={d.engagement_no}
              onClick={() => router.push(`/engagements/?search=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 12px', borderTop: '1px solid var(--state-error)', fontSize: 12, cursor: 'pointer' }}>
              <span style={{ color: 'var(--state-error-fg)', fontFamily: 'var(--font-mono)' }}>{d.engagement_no}</span>
              <span style={{ color: 'var(--text-1)' }}>{d.influencer}</span>
              <span style={{ color: 'var(--state-error-fg)' }}>{d.lifecycle === 'cancelled' ? 'cancelled' : 'returned to origin'}</span>
              {/* Only a COURIER return date may be printed as "Nd ago". `lifecycle_changed_at`
                  is NULL on 85% of rto/cancelled rows, and those fall back to a stage click —
                  printing that as the return date is a wrong number that reads right. */}
              {d.anchor_source === 'courier' && Number.isFinite(d.days_since) && (
                <span style={{ color: 'var(--text-3)' }}>{d.days_since}d ago</span>
              )}
              {d.courier && <span style={{ color: 'var(--text-3)' }}>{d.courier}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{d.stage}</span>
            </div>
          ))}
        </div>
      </div>
    )}
    </>
  );
}
