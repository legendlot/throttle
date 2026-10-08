'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import { titleish } from '../../../lib/productLabel.js';
import { istToday, istMonth } from '../../../lib/istDate.js';
import { STAGE_LABELS, STAGE_PALETTE, TERMINAL_FAIL } from '../../../lib/stages.js';
import { Segmented, StagePill, TableCard, Row } from '../../../components/ui/index.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const LIST_COLS = '100px 150px minmax(150px,1.3fr) minmax(130px,1fr) 130px 110px 80px';
const DAY_MS = 86400000;

function influencerLabel(e) {
  const i = e.influencer || {};
  return i.channel_name || i.person_name || i.influencer_code || '—';
}

// Overdue mirrors the worker's rule (getOverdueEngagements: POSTED_OR_TERMINAL + post_date null), minus
// its grace days — this is a calendar tint, not the rating signal. Draft received, on hold and delayed
// are deliberately NOT late; a deal with a post_date has posted whatever its stage (S412 review).
const NOT_OVERDUE = new Set(['posting', 'live', 'on_hold', 'delayed', ...TERMINAL_FAIL]);
const PAUSED = new Set(['on_hold', 'delayed']);
const CALLED_OFF = { fg: 'var(--text-3)', bg: 'var(--chip-neutral)' };
function isOverdue(e, today) {
  return !!e.effective_date && e.is_planned && e.effective_date < today && !NOT_OVERDUE.has(e.stage);
}
// Calendar-chip colour: overdue red, live green, draft received orange, paused amber, called off
// neutral, everything else the scheduled blue. From the app-wide stage palette.
function tone(e, today) {
  if (isOverdue(e, today)) return { fg: 'var(--state-error-fg)', bg: 'var(--state-error-bg)' };
  if (TERMINAL_FAIL.has(e.stage)) return CALLED_OFF;
  const p = STAGE_PALETTE[e.stage === 'live' || e.stage === 'posting' || PAUSED.has(e.stage) ? e.stage : 'scheduled'];
  return { fg: p.fg, bg: p.bg };
}
function whenLabel(e, today) {
  if (TERMINAL_FAIL.has(e.stage)) return { text: STAGE_LABELS[e.stage] || e.stage, color: 'var(--text-4)' };
  if (isOverdue(e, today)) {
    const late = Math.round((Date.parse(today) - Date.parse(e.effective_date)) / DAY_MS);
    return { text: `${late}d late`, color: 'var(--state-error-fg)' };
  }
  if (!e.is_planned) return { text: 'Posted', color: 'var(--state-success-fg)' };   // worker: post_date set
  const diff = Math.round((Date.parse(e.effective_date) - Date.parse(today)) / DAY_MS);
  if (diff < 0) return { text: STAGE_LABELS[e.stage] || e.stage, color: 'var(--text-2)' };   // paused / draft in
  if (diff === 0) return { text: 'Today', color: 'var(--state-success-fg)' };
  return { text: `in ${diff}d`, color: 'var(--text-2)' };
}
// Month anchor in IST (not the browser's zone) so "Today" never opens the previous month.
function istAnchor() { const [yy, mm] = istMonth().split('-').map(Number); return new Date(yy, mm - 1, 1); }

export default function SchedulePage() {
  const { session } = useAuth();
  const router = useRouter();
  const [view, setView] = useState('calendar');
  const [anchor, setAnchor] = useState(istAnchor);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = fmt(new Date(y, m, 1));
  const to = fmt(new Date(y, m + 1, 0));
  const todayStr = istToday();

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

  // Calendar grid cells (Monday first): out-of-month filler days from the neighbouring months
  // ({ n, out: true }) around each day of the month. Fillers carry no deals — only this month is fetched.
  const cells = useMemo(() => {
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const arr = [];
    for (let i = lead; i > 0; i--) arr.push({ n: prevDays - i + 1, out: true });
    for (let d = 1; d <= daysInMonth; d++) arr.push({ n: d });
    for (let d = 1; arr.length % 7 !== 0; d++) arr.push({ n: d, out: true });
    return arr;
  }, [y, m]);

  function goMonth(delta) { setAnchor(new Date(y, m + delta, 1)); }
  function goToday() { setAnchor(istAnchor()); }

  const legend = [
    ['Scheduled', STAGE_PALETTE.scheduled.fg], ['Draft received', STAGE_PALETTE.posting.fg],
    ['Live', STAGE_PALETTE.live.fg], ['On hold / delayed', STAGE_PALETTE.on_hold.fg],
    ['Called off', CALLED_OFF.fg], ['Overdue', 'var(--state-error-fg)'],
  ];

  return (
    <div style={{ maxWidth: 1280, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', animation: 'igUp 500ms cubic-bezier(.22,1,.36,1) both' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>Work · Post dates</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Schedule</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => goMonth(-1)} className="ig-row" style={navBtn} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <span style={{ minWidth: 130, textAlign: 'center', padding: '0 10px', fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700, color: 'var(--text-1)' }}>{MONTHS[m]} {y}</span>
            <button onClick={() => goMonth(1)} className="ig-row" style={navBtn} aria-label="Next month"><ChevronRight size={16} /></button>
            <button onClick={goToday} className="ig-row" style={{ ...navBtn, width: 'auto', padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-ui)', fontWeight: 600 }}>Today</button>
          </div>
          <Segmented value={view} onChange={setView} options={[{ value: 'calendar', label: 'Calendar' }, { value: 'list', label: 'List' }]} />
        </div>
      </header>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-3)', animation: 'igUp 500ms 40ms both' }}>
        {legend.map(([label, c]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />{label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>{rows.length} in {MONTHS[m]}</span>
      </div>

      <ChasingList session={session} router={router} />

      {loading ? <Spinner /> : view === 'calendar' ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflowX: 'auto', animation: 'igUp 500ms 80ms cubic-bezier(.22,1,.36,1) both' }}>
          <div style={{ minWidth: 640 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', borderBottom: '1px solid var(--border)' }}>
              {WEEKDAYS.map(w => (
                <span key={w} style={{ padding: '10px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-4)' }}>{w}</span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gridAutoRows: 'minmax(118px, auto)', gap: 1, background: 'var(--border)' }}>
              {cells.map((c, i) => {
                if (c.out) return (
                  <div key={`o${i}`} style={{ background: 'var(--surface-sunk)', padding: 8, minWidth: 0 }}>
                    <span style={dayNum(false, true)}>{c.n}</span>
                  </div>
                );
                const key = `${y}-${pad(m + 1)}-${pad(c.n)}`;
                const items = byDay[key] || [];
                const isToday = key === todayStr;
                return (
                  <div key={key} style={{ background: 'var(--surface)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    <span style={dayNum(isToday, false)}>{c.n}</span>
                    {items.slice(0, 4).map(e => {
                      const t = tone(e, todayStr);
                      return (
                        <div key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                          title={`${e.engagement_no} · ${influencerLabel(e)}${e.product_code ? ` · ${titleish(e.product_code)}` : ''}`}
                          style={{ display: 'block', cursor: 'pointer', padding: '4px 7px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: t.fg, background: t.bg, borderLeft: `3px solid ${t.fg}` }}>
                          {influencerLabel(e)}
                        </div>
                      );
                    })}
                    {items.length > 4 && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>+{items.length - 4} more</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <TableCard columns={LIST_COLS} minWidth={760} head={['Date', 'Deal', 'Influencer', 'Product', 'Stage', 'When', 'Post']}>
          {rows.length === 0 && <div style={{ padding: '14px 18px', color: 'var(--text-3)', textAlign: 'center', fontSize: 14 }}>Nothing scheduled in {MONTHS[m]} {y}</div>}
          {rows.map((e, i) => {
            const w = e.effective_date ? whenLabel(e, todayStr) : null;
            return (
              <Row key={e.id} columns={LIST_COLS} index={i} animate onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, whiteSpace: 'nowrap' }}>{e.effective_date}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent-hi)', fontWeight: 600 }}>{e.engagement_no}</span>
                <span style={{ fontWeight: 600, minWidth: 0 }}>{influencerLabel(e)}</span>
                <span style={{ color: 'var(--text-2)', minWidth: 0 }}>{titleish(e.product_code) || '—'}</span>
                <span style={{ justifySelf: 'start' }}><StagePill stage={e.stage} /></span>
                <span style={{ fontSize: 13, fontWeight: 600, color: w ? w.color : 'var(--text-3)' }}>{w ? w.text : '—'}</span>
                <span>
                  {e.video_link
                    ? <a href={e.video_link} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} style={{ color: 'var(--accent)' }}>Watch ↗</a>
                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </span>
              </Row>
            );
          })}
        </TableCard>
      )}
    </div>
  );
}

function dayNum(today, out) {
  return {
    alignSelf: 'flex-start', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, borderRadius: '50%', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
    color: today ? 'var(--accent-fg)' : out ? 'var(--text-5)' : 'var(--text-2)',
    background: today ? 'var(--accent)' : 'transparent',
  };
}
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-2)', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-mono)' };

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
    <div style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>
      {notice}
    </div>
  );
  if (failed) return <Notice />;
  // ⚠️ S369 hostile review: this line rescued only `degraded`, so the truncation and courier
  // notices were unreachable in the ONE case they exist for — an empty-looking list. A scan that
  // stopped at the cap with nothing yet overdue rendered as a blank, reassuring page. Gate on the
  // notice itself, so any reason to distrust the list survives the empty short-circuit.
  if (!data || (!data.count && !returned.length && !stuck.length)) return notice ? <Notice /> : null;
  return (
    <>
    {notice && <Notice />}
    {data.count > 0 && (
    <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'left' }}>
        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{data.count}</span>
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
              onClick={() => router.push(`/engagements/detail/?engagement_no=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, cursor: 'pointer' }}>
              <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{d.engagement_no}</span>
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
      <div style={{ marginBottom: 12, border: '1px solid var(--state-warning)', borderRadius: 'var(--r-card)', background: 'var(--state-warning-bg)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-1)' }}>
          <span style={{ color: 'var(--state-warning-fg)', fontWeight: 700 }}>{stuck.length}</span>
          <span>parcel{stuck.length === 1 ? '' : 's'} still in flight after 14+ days — chase the courier, not the creator</span>
        </div>
        <div style={{ borderTop: '1px solid var(--state-warning)' }}>
          {stuck.map(d => (
            <div key={d.engagement_no}
              onClick={() => router.push(`/engagements/detail/?engagement_no=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '7px 12px', borderTop: '1px solid var(--state-warning)', fontSize: 12, cursor: 'pointer' }}>
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
      <div style={{ marginBottom: 12, border: '1px solid var(--state-error)', borderRadius: 'var(--r-card)', background: 'var(--state-error-bg)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-1)' }}>
          <span style={{ color: 'var(--state-error-fg)', fontWeight: 700 }}>{returned.length}</span>
          <span>parcel{returned.length === 1 ? '' : 's'} came back — the creator never received the product, so do not chase</span>
        </div>
        <div style={{ borderTop: '1px solid var(--state-error)' }}>
          {returned.map(d => (
            <div key={d.engagement_no}
              onClick={() => router.push(`/engagements/detail/?engagement_no=${encodeURIComponent(d.engagement_no)}`)}
              style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '7px 12px', borderTop: '1px solid var(--state-error)', fontSize: 12, cursor: 'pointer' }}>
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
