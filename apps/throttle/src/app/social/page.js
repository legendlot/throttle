'use client';
/* Social — content calendar (week + month). Channels, products, scheduled
   posts with status; schedule modal, day popover, post drawer, drag posts
   between days. Live posts come from getSocialFeed (June 2026 maps onto the
   grid); schedule/move best-effort via createSocialPost / updateSocialPost.
   Unauthenticated → seed + localStorage (faithful to the prototype). */
import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card, ProductTag, PrimaryBtn, Pill } from '@/components/throttle/ui';
import { toast } from '@/components/throttle/ToastHost';
import { CHANNELS, POST_STATUS, SOCIAL_WEEK, SOCIAL_MONTH, PRODUCTS, lsGet, lsSet } from '@/lib/throttleData';
import { fetchSocialFeed, fetchChannels, createSocialPostLive, moveSocialPostLive, fetchProducts } from '@/lib/throttleApi';

const REAL_TO_PROTO = { published: 'posted', approved: 'scheduled', idea: 'draft', draft: 'draft', cancelled: 'draft', review: 'review' };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const pad2 = n => String(n).padStart(2, '0');

/* ── Calendar grids are DERIVED from a cursor date, never hardcoded ──────────
   Until 2026-08-05 this screen was pinned to June 2026 (a `MONTH_META` seed
   constant, a literal "JUNE 2026" heading and `Jun ${day}` labels), so the
   month arrows had nothing to move and the team could not schedule outside
   June (Kirti, #bugs 1785911751). Everything below keys off `iso` — a real
   YYYY-MM-DD — so posts can never be attributed to the same day-of-month in
   the wrong month, which the old day-number keying did silently. */
const DOWS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const isoOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const dowIdxOf = d => (d.getDay() + 6) % 7;            // 0 = Monday, matching the grid header
const mondayOf = d => { const x = new Date(d); x.setDate(x.getDate() - dowIdxOf(x)); x.setHours(0, 0, 0, 0); return x; };
const shortDow = i => DOWS[i].charAt(0) + DOWS[i].slice(1).toLowerCase();

function monthGrid(cursor) {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const total = new Date(y, m + 1, 0).getDate();
  const leadBlanks = dowIdxOf(new Date(y, m, 1));
  const days = [];
  for (let day = 1; day <= total; day++) {
    const d = new Date(y, m, day);
    days.push({ day, dow: DOWS[dowIdxOf(d)], dowIdx: dowIdxOf(d), iso: isoOf(d), posts: [] });
  }
  return { days, leadBlanks, label: `${MONTH_NAMES[m]} ${y}`.toUpperCase(), monthName: MONTH_NAMES[m] };
}

function weekGrid(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
    return { date: pad2(d.getDate()), dow: DOWS[dowIdxOf(d)], label: `${shortDow(dowIdxOf(d))} ${d.getDate()}`,
      iso: isoOf(d), day: d.getDate(), posts: [] };
  });
}

function weekLabel(weekStart) {
  const end = new Date(weekStart); end.setDate(weekStart.getDate() + 6);
  const a = MONTH_NAMES[weekStart.getMonth()].slice(0, 3);
  const b = MONTH_NAMES[end.getMonth()].slice(0, 3);
  return a === b
    ? `WEEK OF ${a} ${weekStart.getDate()} – ${end.getDate()}`.toUpperCase()
    : `WEEK OF ${a} ${weekStart.getDate()} – ${b} ${end.getDate()}`.toUpperCase();
}

function buildFromFeed(feed, monthDays, weekDays) {
  const byIso = {};
  (feed || []).forEach(p => {
    const iso = String(p.scheduled_date || '').slice(0, 10);
    if (!iso) return;
    const v0 = (p.variants || [])[0];
    const platform = v0?.channel?.platform;
    const channel = ['instagram', 'youtube', 'whatsapp', 'linkedin'].includes(platform) ? platform : 'instagram';
    (byIso[iso] = byIso[iso] || []).push({
      id: p.id, time: (p.scheduled_time || '12:00').slice(0, 5), channel,
      product: p.product_code ? String(p.product_code).toUpperCase() : null,
      title: p.title, status: REAL_TO_PROTO[p.status] || 'draft',
      fmt: v0?.content_type ? cap(v0.content_type) : 'Post',
    });
  });
  const month = monthDays.map(d => ({ ...d, posts: (byIso[d.iso] || []).slice() }));
  const week = weekDays.map(d => ({ ...d, posts: (byIso[d.iso] || []).slice().sort((a, b) => a.time.localeCompare(b.time)) }));
  return { month, week };
}

function SchedulePostModal({ open, onClose, onSave, preset, dayOptions, monthMode, products, periodName }) {
  const opts = dayOptions || SOCIAL_WEEK.map(d => ({ value: d.date, label: d.label }));
  const [form, setForm] = useState({ channel: 'instagram', product: '', title: '', date: preset || opts[0].value, time: '12:00', fmt: 'Reel', status: 'draft' });
  useEffect(() => { if (open) setForm({ channel: 'instagram', product: '', title: '', date: preset || opts[0].value, time: '12:00', fmt: 'Reel', status: 'draft' }); }, [open, preset]);
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const field = { width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '10px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14, outline: 'none' };
  const label = { fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', display: 'block', marginBottom: 7 };
  const save = () => {
    const picked = opts.find(o => String(o.value) === String(form.date));
    onSave({ ...form, id: 'p' + Math.random().toString(36).slice(2, 6) });
    toast(`Post scheduled · ${CHANNELS[form.channel].label} · ${picked?.label || form.date}`, 'ok', 'send');
    onClose();
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 420, background: 'rgba(8,8,10,0.62)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '9vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(540px, 94vw)', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, letterSpacing: '0.06em', color: 'var(--t1)', textTransform: 'uppercase' }}>Schedule Post</span>
          <button onClick={onClose} className="t-iconbtn" style={{ marginLeft: 'auto', width: 30, height: 30 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={label}>Channel</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.entries(CHANNELS).map(([k, ch]) => (
                <button key={k} onClick={() => set('channel', k)} className="t-chip" data-on={form.channel === k}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: ch.color, display: 'inline-block', marginRight: 6 }} />{ch.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={label}>Caption / title</label>
            <input autoFocus value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Corner fast — Flare drift reel" style={field} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Every product, from product_master — NOT a hardcoded slice. The old
                `PRODUCTS.slice(0, 4)` showed four of eight and no new product ever. */}
            <div><label style={label}>Product</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 132, overflowY: 'auto' }}>
                <button onClick={() => set('product', '')} className="t-chip" data-on={form.product === ''}>Brand</button>
                {(products || []).map(code => <button key={code} onClick={() => set('product', code)} className="t-chip" data-on={form.product === code}>{code}</button>)}
              </div>
            </div>
            <div><label style={label}>Format</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {['Reel', 'Carousel', 'Story', 'Video', 'Post'].map(f => <button key={f} onClick={() => set('fmt', f)} className="t-chip" data-on={form.fmt === f}>{f}</button>)}
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div><label style={label}>Day{periodName ? ` (${periodName})` : ''}</label>
              <select value={form.date} onChange={e => set('date', e.target.value)} style={field}>
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select></div>
            <div><label style={label}>Time</label><input value={form.time} onChange={e => set('time', e.target.value)} style={field} /></div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="t-btn" style={{ padding: '10px 15px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Cancel</button>
          <PrimaryBtn icon="send" onClick={save}>Schedule</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

function PostDrawer({ post, onClose }) {
  useEffect(() => {
    if (!post) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [post, onClose]);
  if (!post) return null;
  const ch = CHANNELS[post.channel]; const st = POST_STATUS[post.status] || POST_STATUS.draft;
  const tone = { posted: 'ok', scheduled: 'info', review: 'info', draft: 'info' }[post.status] || 'info';
  return (
    <div onClick={onClose} className="t-drawer-back" style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(8,8,10,0.55)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="t-drawer-panel" style={{ width: 'min(420px, 94vw)', height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--border-2)', boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: ch.color }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: ch.color }} />{ch.label}</span>
          <Pill tone={tone} dot>{st.label}</Pill>
          <button onClick={onClose} className="t-iconbtn" style={{ marginLeft: 'auto', width: 30, height: 30 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px' }}>
          <h2 style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 18, color: 'var(--t1)', lineHeight: 1.3, margin: '0 0 16px' }}>{post.title}</h2>
          <div style={{ width: '100%', aspectRatio: '4 / 5', borderRadius: 'var(--r-sm)', background: 'var(--bg-2)', border: '1px dashed var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--t4)', marginBottom: 18 }}>
            <div style={{ textAlign: 'center' }}><Icon name="image" size={26} /><div style={{ fontSize: 11.5, marginTop: 8 }}>{post.fmt} creative</div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px' }}>
            {[['Format', post.fmt], ['Time', post.time], ['Product', post.product || 'Brand'], ['Status', st.label]].map(([k, v]) => (
              <div key={k}><div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>{k}</div><div style={{ fontSize: 13.5, color: 'var(--t1)' }}>{v}</div></div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button onClick={() => { toast('Post approved for publishing.', 'ok', 'check'); onClose(); }} className="t-btn" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px', borderRadius: 'var(--r-sm)', background: 'var(--yellow)', color: '#15140b', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}><Icon name="check" size={14} />Approve</button>
          <button onClick={onClose} className="t-btn" style={{ padding: '11px 15px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Edit</button>
        </div>
      </div>
    </div>
  );
}

function PostCard({ post, onOpen }) {
  const ch = CHANNELS[post.channel]; const st = POST_STATUS[post.status] || POST_STATUS.draft;
  return (
    <div onClick={() => onOpen(post)} className="t-card t-task" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
      borderLeft: `3px solid ${ch.color}`, padding: '9px 10px', cursor: 'pointer', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{post.time}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: ch.color }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: ch.color }} />{ch.short}</span>
        <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: st.color }} title={st.label} />
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--t1)', lineHeight: 1.35, margin: '0 0 7px', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{post.title}</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <ProductTag code={post.product} />
        <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-display)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{post.fmt}</span>
      </div>
    </div>
  );
}

function MonthView({ month, channel, onMovePost, onOpenPost, onOpenDay, leadBlanks = 0 }) {
  const dayPosts = d => channel ? d.posts.filter(p => p.channel === channel) : d.posts;
  const planned = month.filter(d => dayPosts(d).length > 0).length;
  const totalPosts = month.reduce((s, d) => s + dayPosts(d).length, 0);
  const coverage = month.length ? Math.round((planned / month.length) * 100) : 0;
  const weeks = [];
  for (let w = 0; w < Math.ceil((leadBlanks + month.length) / 7); w++) weeks.push(month.slice(w * 7, w * 7 + 7));
  // "Today"/"past" are real dates now, so they are correct in every month —
  // and a future month has no past days rather than half the grid dimmed.
  const todayIso = isoOf(new Date());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexShrink: 0, flexWrap: 'wrap' }}>
        <Card style={{ display: 'flex', alignItems: 'center', gap: 18, flex: 1, minWidth: 260 }}>
          <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
            <svg width="64" height="64" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="27" fill="none" stroke="var(--surface-2)" strokeWidth="6" />
              <circle cx="32" cy="32" r="27" fill="none" stroke="var(--yellow)" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 27 * coverage / 100} ${2 * Math.PI * 27}`} transform="rotate(-90 32 32)" />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <span className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{coverage}%</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 14.5, color: 'var(--t1)', fontWeight: 600 }}>{planned} of {month.length} days planned</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>{month.length - planned} open days · {totalPosts} posts scheduled this month</div>
          </div>
        </Card>
        <Card style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="eyebrow" style={{ padding: 0 }}>Weekly coverage</span>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 42 }}>
            {weeks.map((wk, i) => {
              const wp = wk.filter(d => dayPosts(d).length > 0).length;
              const wc = Math.round((wp / wk.length) * 100);
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 22, height: 34, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse' }}>
                    <div style={{ height: `${wc}%`, background: wc >= 70 ? 'var(--ok-fg)' : wc >= 40 ? 'var(--yellow)' : 'var(--warn-fg)' }} />
                  </div>
                  <span className="num" style={{ fontSize: 9.5, color: 'var(--t4)' }}>W{i + 1}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
          {DOWS.map(d => <div key={d} style={{ textAlign: 'center', fontFamily: 'var(--font-display)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--t4)', paddingBottom: 2 }}>{d}</div>)}
          {Array.from({ length: leadBlanks }).map((_, i) => <div key={'b' + i} />)}
          {month.map(d => {
            const posts = dayPosts(d);
            const today = d.iso === todayIso;
            const past = !!d.iso && d.iso < todayIso;
            const empty = posts.length === 0;
            const gap = empty && d.dowIdx < 5 && !past;
            return (
              <div key={d.day} onClick={e => onOpenDay(d.day, e)}
                onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-3)'; }}
                onDragLeave={e => { e.currentTarget.style.borderColor = ''; }}
                onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = ''; try { const o = JSON.parse(e.dataTransfer.getData('text/plain')); onMovePost(o.id, o.from, d.day); } catch (_) {} }}
                className="t-monthcell"
                style={{ minHeight: 104, borderRadius: 'var(--r-sm)', padding: '7px 8px', cursor: 'pointer',
                  background: today ? 'var(--brand-bg)' : 'var(--bg-2)',
                  border: today ? '1px solid var(--brand-bd)' : gap ? '1px dashed var(--border-2)' : '1px solid var(--border)',
                  opacity: past && empty ? 0.5 : 1, display: 'flex', flexDirection: 'column', gap: 5, transition: 'border-color .12s' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="num" style={{ fontSize: 13, fontWeight: 600, color: today ? 'var(--yellow)' : past ? 'var(--t4)' : 'var(--t2)' }}>{d.day}</span>
                  {posts.length > 0 && <span className="num" style={{ fontSize: 10, color: 'var(--t4)' }}>{posts.length}</span>}
                </div>
                {posts.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {posts.slice(0, 3).map(p => (
                      <div key={p.id} draggable
                        onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ id: p.id, from: d.day })); e.dataTransfer.effectAllowed = 'move'; }}
                        onClick={e => { e.stopPropagation(); onOpenPost(p); }}
                        title={`${CHANNELS[p.channel].label} · ${p.title}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 5px', borderRadius: 3, background: 'var(--surface-2)',
                          border: '1px solid var(--border)', borderLeft: `2px solid ${CHANNELS[p.channel].color}`, cursor: 'grab', opacity: p.status === 'draft' ? 0.7 : 1 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: CHANNELS[p.channel].color, flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--font-display)', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--t3)', flexShrink: 0 }}>{CHANNELS[p.channel].short}</span>
                        <span style={{ fontSize: 9.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.fmt}</span>
                      </div>
                    ))}
                    {posts.length > 3 && <span className="num" style={{ fontSize: 9, color: 'var(--t4)', paddingLeft: 2 }}>+{posts.length - 3} more</span>}
                  </div>
                ) : gap ? (
                  <span style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 'auto' }}>Open</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DayPopover({ day, pos, channel, onClose, onOpenPost, onSchedule }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const posts = channel ? day.posts.filter(p => p.channel === channel) : day.posts;
  const W = 300;
  const left = Math.min(pos.x, window.innerWidth - W - 16);
  const top = Math.min(pos.y, window.innerHeight - 320);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 360 }} />
      <div style={{ position: 'fixed', left, top, width: W, zIndex: 361, background: 'var(--surface)', border: '1px solid var(--border-2)',
        borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em', color: 'var(--t1)' }}>
            {day.iso ? `${MONTH_NAMES[Number(day.iso.slice(5, 7)) - 1].slice(0, 3).toUpperCase()} ${day.day}` : `DAY ${day.day}`}</span>
          <span className="eyebrow" style={{ padding: 0 }}>{day.dow}</span>
          <span className="num" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t4)' }}>{posts.length} post{posts.length === 1 ? '' : 's'}</span>
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', padding: 8 }}>
          {posts.length === 0 && <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--t4)', fontSize: 12 }}>Nothing scheduled.</div>}
          {posts.map(p => {
            const ch = CHANNELS[p.channel]; const st = POST_STATUS[p.status] || POST_STATUS.draft;
            return (
              <button key={p.id} onClick={() => onOpenPost(p)} className="t-cmdrow" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 9px', borderRadius: 'var(--r-sm)', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: ch.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
                  <div className="num" style={{ fontSize: 10, color: 'var(--t4)', marginTop: 1 }}>{p.time} · {ch.label} · {p.fmt}</div>
                </div>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color, flexShrink: 0 }} title={st.label} />
              </button>
            );
          })}
        </div>
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          <button onClick={onSchedule} className="t-btn" style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            padding: '9px', borderRadius: 'var(--r-sm)', background: 'var(--yellow)', color: '#15140b', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            <Icon name="plus" size={14} />Schedule this day</button>
        </div>
      </div>
    </>
  );
}

// The seed prototype's posts are June-2026 dated, so the unauthenticated demo
// still opens on June. A signed-in user opens on the real current month.
const SEED_MONTH = new Date(2026, 5, 1);

function SocialScreen() {
  const { session } = useAuth();
  const live = !!session; // logged in → server-backed, never seed/localStorage
  const [channel, setChannel] = useState(null);
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(() => live ? startOfMonth(new Date()) : SEED_MONTH);
  const [weekStart, setWeekStart] = useState(() => mondayOf(live ? new Date() : new Date(2026, 5, 9)));
  const [products, setProducts] = useState(() => PRODUCTS.map(p => p.code));
  const grid = React.useMemo(() => monthGrid(cursor), [cursor]);
  const weekScaffold = React.useMemo(() => weekGrid(weekStart), [weekStart]);
  const [week, setWeek] = useState(() => live ? weekGrid(mondayOf(new Date())) : lsGet('throttle_week_v1', SOCIAL_WEEK));
  const [month, setMonth] = useState(() => live ? monthGrid(startOfMonth(new Date())).days : lsGet('throttle_month_v1', SOCIAL_MONTH));
  const [selected, setSelected] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const [presetDate, setPresetDate] = useState(null);
  const [dayPop, setDayPop] = useState(null);
  const channelMapRef = useRef({}); // platform -> channel_id

  const stepPeriod = dir => {
    if (view === 'month') setCursor(c => new Date(c.getFullYear(), c.getMonth() + dir, 1));
    else setWeekStart(w => { const n = new Date(w); n.setDate(w.getDate() + dir * 7); return n; });
  };

  useEffect(() => {
    const onSchedule = () => { setPresetDate(null); setScheduling(true); };
    window.addEventListener('throttle:schedulepost', onSchedule);
    return () => window.removeEventListener('throttle:schedulepost', onSchedule);
  }, []);

  // Fetch the union of the visible month and the visible week — the two can sit
  // in different months once you page around, so one range would starve the other.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    const from = [grid.days[0].iso, isoOf(weekStart)].sort()[0];
    const to = [grid.days[grid.days.length - 1].iso, isoOf(weekEnd)].sort().slice(-1)[0];
    (async () => {
      const [feed, channels] = await Promise.all([
        fetchSocialFeed(session, from, to),
        fetchChannels(session),
      ]);
      if (cancelled) return;
      if (channels) { const m = {}; channels.forEach(c => { if (!m[c.platform]) m[c.platform] = c.id; }); channelMapRef.current = m; }
      const built = buildFromFeed(feed || [], grid.days, weekScaffold);
      setWeek(built.week); setMonth(built.month);
    })();
    return () => { cancelled = true; };
  }, [session, grid, weekScaffold, weekStart]);

  // Live product list (product_master) for the schedule modal's chips.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchProducts(session).then(list => { if (!cancelled && list?.length) setProducts(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session]);

  /* Seed/prototype path (logged out). It must rebuild off the same derived grid as
     the live path, otherwise paging to a 31-day month keeps rendering the 30-cell
     June scaffold — "22 of 30 days planned" in August. Storage is keyed per period
     so navigating away no longer overwrites another month's demo posts. */
  const monthKey = `throttle_month_v1_${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
  const weekKey = `throttle_week_v1_${isoOf(weekStart)}`;
  const isSeedMonth = cursor.getFullYear() === 2026 && cursor.getMonth() === 5;
  const isSeedWeek = isoOf(weekStart) === '2026-06-08';

  useEffect(() => {
    if (live) return;
    const stored = lsGet(monthKey, null) || (isSeedMonth ? SOCIAL_MONTH : []);
    const byDay = {};
    stored.forEach(d => { byDay[d.day] = d.posts || []; });
    setMonth(grid.days.map(d => ({ ...d, posts: (byDay[d.day] || []).slice() })));
  }, [live, grid, monthKey, isSeedMonth]);

  useEffect(() => {
    if (live) return;
    const stored = lsGet(weekKey, null) || (isSeedWeek ? SOCIAL_WEEK : []);
    const byDate = {};
    stored.forEach(d => { byDate[String(d.date)] = d.posts || []; });
    setWeek(weekScaffold.map(d => ({ ...d, posts: (byDate[d.date] || []).slice() })));
  }, [live, weekScaffold, weekKey, isSeedWeek]);

  useEffect(() => { if (!live && week.length) lsSet(weekKey, week); }, [week, live, weekKey]);
  useEffect(() => { if (!live && month.length) lsSet(monthKey, month); }, [month, live, monthKey]);

  // The visible rows carry their own `iso`, so a scheduled/moved post lands on the
  // date the user actually sees — not on that day-number in a fixed month.
  const isoForDay = dayVal => (view === 'month'
    ? month.find(d => String(d.day) === String(dayVal))
    : week.find(d => String(d.date) === String(dayVal)))?.iso;

  const addPost = p => {
    const iso = isoForDay(p.date);
    if (view === 'month') setMonth(prev => prev.map(d => String(d.day) === String(p.date) ? { ...d, posts: [...d.posts, p] } : d));
    else setWeek(prev => prev.map(d => d.date === p.date ? { ...d, posts: [...d.posts, p].sort((a, b) => a.time.localeCompare(b.time)) } : d));
    if (live && session && iso) {
      createSocialPostLive(session, {
        title: p.title || `${p.product || 'Brand'} ${p.fmt}`, dateISO: iso, time: p.time, status: p.status,
        productCode: p.product || undefined, channelId: channelMapRef.current[p.channel], platform: p.channel, fmt: p.fmt,
      }).catch(() => toast('Saved locally — could not sync to server.', 'warn', 'alert'));
    }
  };
  const movePost = (postId, fromDay, toDay) => {
    if (String(fromDay) === String(toDay)) return;
    const target = month.find(d => String(d.day) === String(toDay));
    setMonth(prev => {
      let moved = null;
      const cleared = prev.map(d => { if (String(d.day) === String(fromDay)) { const p = d.posts.find(x => x.id === postId); if (p) moved = p; return { ...d, posts: d.posts.filter(x => x.id !== postId) }; } return d; });
      if (!moved) return prev;
      return cleared.map(d => String(d.day) === String(toDay) ? { ...d, posts: [...d.posts, moved] } : d);
    });
    toast(`Post moved to ${grid.monthName.slice(0, 3)} ${toDay}`, 'ok', 'calendar');
    if (live && session && target?.iso) moveSocialPostLive(session, postId, target.iso).catch(() => {});
  };
  const openSchedule = date => { setPresetDate(date); setDayPop(null); setScheduling(true); };
  const openDay = (day, e) => { const r = e.currentTarget.getBoundingClientRect(); setDayPop({ day, x: r.left, y: r.bottom + 6 }); };
  const monthDayOpts = month.map(d => ({ value: String(d.day), label: `${grid.monthName.slice(0, 3)} ${d.day} · ${d.dow.charAt(0) + d.dow.slice(1).toLowerCase()}` }));
  const popDay = dayPop && month.find(d => d.day === dayPop.day);

  const allPosts = week.flatMap(d => d.posts);
  const counts = Object.keys(CHANNELS).map(c => ({ c, n: allPosts.filter(p => p.channel === c).length }));
  const total = allPosts.length;
  const byStatus = Object.keys(POST_STATUS).map(s => ({ s, n: allPosts.filter(p => p.status === s).length }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => stepPeriod(-1)} title={view === 'month' ? 'Previous month' : 'Previous week'} className="t-iconbtn" style={{ width: 30, height: 30 }}><Icon name="chevronLeft" size={15} /></button>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--t1)', minWidth: view === 'month' ? 130 : 190, textAlign: 'center' }}>{view === 'month' ? grid.label : weekLabel(weekStart)}</span>
          <button onClick={() => stepPeriod(1)} title={view === 'month' ? 'Next month' : 'Next week'} className="t-iconbtn" style={{ width: 30, height: 30 }}><Icon name="chevronRight" size={15} /></button>
          <button onClick={() => { setCursor(startOfMonth(new Date())); setWeekStart(mondayOf(new Date())); }}
            className="t-chip" style={{ marginLeft: 2 }}>Today</button>
        </div>
        <div style={{ display: 'flex', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 2 }}>
          {['week', 'month'].map(v => (
            <button key={v} onClick={() => setView(v)} style={{ padding: '6px 14px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', borderRadius: 4, border: 'none', cursor: 'pointer', background: view === v ? 'var(--surface-3)' : 'transparent', color: view === v ? 'var(--t1)' : 'var(--t3)' }}>{v}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button onClick={() => setChannel(null)} className="t-chip" data-on={channel === null}>All</button>
            {Object.entries(CHANNELS).map(([k, ch]) => (
              <button key={k} onClick={() => setChannel(k)} className="t-chip" data-on={channel === k}>{ch.label}</button>
            ))}
          </div>
          <PrimaryBtn icon="send" onClick={() => window.dispatchEvent(new CustomEvent('throttle:schedulepost'))}>Schedule post</PrimaryBtn>
        </div>
      </div>

      {view === 'week' && (
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexShrink: 0, flexWrap: 'wrap' }}>
        <Card pad={0} style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 16, padding: '13px 16px' }}>
          <div><div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, color: 'var(--t1)', lineHeight: 1 }}>{total}</div>
            <div className="eyebrow" style={{ padding: 0, marginTop: 4 }}>Posts this week</div></div>
          <div style={{ flex: 1, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {counts.map(({ c, n }) => (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: CHANNELS[c].color }} />
                {CHANNELS[c].label}<span className="num" style={{ color: 'var(--t1)', fontWeight: 700 }}>{n}</span></span>
            ))}
          </div>
        </Card>
        <Card pad={0} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 18px' }}>
          {byStatus.map(({ s, n }) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: POST_STATUS[s].color }} />
              {POST_STATUS[s].label}<span className="num" style={{ color: 'var(--t1)', fontWeight: 700 }}>{n}</span></span>
          ))}
        </Card>
      </div>
      )}

      {view === 'month' ? (
        <MonthView month={month} channel={channel} onMovePost={movePost} onOpenPost={setSelected} onOpenDay={openDay} leadBlanks={grid.leadBlanks} />
      ) : (
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(170px, 1fr))', gap: 12, height: '100%', minWidth: 'max-content' }}>
          {week.map(day => {
            const today = day.date === '13';
            const posts = channel ? day.posts.filter(p => p.channel === channel) : day.posts;
            return (
              <div key={day.date} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', flexShrink: 0,
                  borderRadius: 'var(--r-sm)', marginBottom: 8, background: today ? 'var(--brand-bg)' : 'transparent',
                  border: today ? '1px solid var(--brand-bd)' : '1px solid transparent' }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: today ? 'var(--yellow)' : 'var(--t4)' }}>{day.dow}</span>
                    <span className="num" style={{ fontSize: 15, fontWeight: 600, color: today ? 'var(--yellow)' : 'var(--t2)' }}>{day.date}</span>
                  </span>
                  {posts.length > 0 && <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{posts.length}</span>}
                </div>
                <div className="t-col-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflowY: 'auto',
                  padding: 6, borderRadius: 'var(--r-sm)', background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
                  {posts.map(p => <PostCard key={p.id} post={p} onOpen={setSelected} />)}
                  <button onClick={() => openSchedule(day.date)} className="t-addpost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px',
                    background: 'transparent', border: '1px dashed var(--border-2)', borderRadius: 'var(--r-sm)', color: 'var(--t4)',
                    cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                    <Icon name="plus" size={13} />Add</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}

      <SchedulePostModal open={scheduling} preset={presetDate} monthMode={view === 'month'}
        dayOptions={view === 'month' ? monthDayOpts : week.map(d => ({ value: d.date, label: d.label }))}
        products={products} periodName={view === 'month' ? grid.monthName : undefined}
        onClose={() => setScheduling(false)} onSave={addPost} />
      <PostDrawer post={selected} onClose={() => setSelected(null)} />
      {dayPop && popDay && (
        <DayPopover day={popDay} pos={dayPop} channel={channel} onClose={() => setDayPop(null)} onOpenPost={p => { setDayPop(null); setSelected(p); }} onSchedule={() => openSchedule(String(dayPop.day))} />
      )}
    </div>
  );
}

export default function SocialPage() {
  return <AppShell route="social"><SocialScreen /></AppShell>;
}
