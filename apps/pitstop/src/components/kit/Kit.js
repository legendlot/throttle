'use client';
/* ════════════════════════════════════════════════════════════
   PITSTOP "Volt" kit — app-local building blocks.
   Mirrors the Redline Pit Wall v2 kit pattern (app-local, NOT
   shared @throttle/ui — zero blast radius on the other apps).
   Ported from the Volt prototype (the .dc.html is the pixel
   source of truth for markup + spacing). Differences from the
   prototype: lucide-react icons via <Icon/>, everything
   parameterized (no mock globals).
   ════════════════════════════════════════════════════════════ */
import { useState } from 'react';
import { Icon } from './Icon.js';

export { Icon } from './Icon.js';

/* ── number formatter (en-IN) ──────────────────────────────── */
export const fmt = n => (n == null || Number.isNaN(Number(n)) ? '0' : Number(n).toLocaleString('en-IN'));

/* ── IST clock helpers ─────────────────────────────────────── */
export function istTimeLabel(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d instanceof Date ? d : new Date(d));
  } catch { return ''; }
}

/* ── severity palette ──────────────────────────────────────── */
export const SEV = {
  high: { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',  bd: 'var(--bad-bd)' },
  med:  { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', bd: 'var(--warn-bd)' },
  low:  { fg: 'var(--info-fg)', bg: 'var(--info-bg)', bd: 'var(--info-bd)' },
};
export const sevPalette = sev => SEV[sev] || SEV.low;

/* ── stage lifecycle (mirrors worker allowedTransitions / DB CHECK) ── */
export const SHARED_STAGES = ['intake', 'awaiting_evidence', 'verified', 'pickup_scheduled', 'picked_up', 'at_warehouse', 'inspected'];
export const BRANCH_STAGES = {
  replacement: ['replacement_dispatched'],
  refund: ['refund_initiated', 'refund_completed'],
  repair: ['handed_to_production', 'repaired_ready', 'repair_dispatched'],
};
export const STAGE_LABEL = {
  intake: 'Intake', awaiting_evidence: 'Awaiting evidence', verified: 'Verified',
  pickup_scheduled: 'Pickup scheduled', picked_up: 'Picked up', at_warehouse: 'At warehouse',
  inspected: 'Inspected', replacement_dispatched: 'Replacement dispatched',
  refund_initiated: 'Refund initiated', refund_completed: 'Refund completed',
  handed_to_production: 'Handed to production', repaired_ready: 'Repaired ready',
  repair_dispatched: 'Repair dispatched', closed: 'Closed',
  cancelled: 'Cancelled', rejected: 'Rejected', escalated: 'Escalated',
};
export function lifecycle(disp) {
  if (disp === 'query' || disp === 'no_action') return ['intake', 'closed'];
  if (disp === 'awaiting_info') return ['intake', 'awaiting_evidence'];
  return [...SHARED_STAGES, ...(BRANCH_STAGES[disp] || []), 'closed'];
}

/* ════════════════════════════════════════════════════════════
   KpiCard — eyebrow + mono value + sub + 3px left tone stripe.
   Replaces the old plain card (handoff §4). `tone` = a CSS color.
   `size` tunes the value (overview 27 · queue/calls 26 · reports 25).
   ════════════════════════════════════════════════════════════ */
export function KpiCard({ label, value, sub, subTone, tone = 'var(--accent)', icon, size = 26 }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: 'var(--cardpad)', position: 'relative',
      overflow: 'hidden', boxShadow: 'var(--glow)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: tone }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        {icon && <Icon name={icon} size={13} style={{ color: tone }} />}
        <span className="eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.12em' }}>{label}</span>
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: size, color: 'var(--t1)', lineHeight: 1 }}>{value}</div>
      {sub != null && sub !== '' && (
        <div style={{ fontSize: 11.5, color: subTone || 'var(--t3)', marginTop: 6, fontWeight: 500 }}>{sub}</div>
      )}
    </div>
  );
}

/* ── Panel — canonical card (header row + padded body) ─────── */
export function Panel({ title, sub, action, pad = 'var(--cardpad)', children, style, bodyStyle }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden', display: 'flex', flexDirection: 'column', ...style }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '13px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="label" style={{ fontSize: 11, color: 'var(--t1)', fontWeight: 700 }}>{title}</span>
            {sub && <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{sub}</span>}
          </div>
          {action}
        </div>
      )}
      <div style={{ padding: pad, flex: 1, minHeight: 0, ...bodyStyle }}>{children}</div>
    </div>
  );
}

/* ── SectionHead — Tomorrow eyebrow over a content block ───── */
export function SectionHead({ children, action, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: 12, marginBottom: 'var(--gap)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontFamily: 'var(--f-display)', fontWeight: 600, fontSize: 16, letterSpacing: '0.03em',
          color: 'var(--t1)', textTransform: 'uppercase', margin: 0 }}>{children}</h2>
        {sub && <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{sub}</span>}
      </div>
      {action}
    </div>
  );
}

/* ── DatePresets — Today / Week / Month segmented toggle ───── */
export function DatePresets({ value, onChange, options = [['today', 'Today'], ['week', 'Week'], ['month', 'Month']] }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      {options.map(([id, label]) => {
        const active = value === id;
        return (
          <button key={id} onClick={() => onChange && onChange(id)}
            style={{ fontFamily: 'var(--f-ui)', fontSize: 12, fontWeight: 600, padding: '5px 12px',
              borderRadius: 5, border: 'none', cursor: 'pointer',
              background: active ? 'var(--surface-3)' : 'transparent',
              color: active ? 'var(--t1)' : 'var(--t3)' }}>{label}</button>
        );
      })}
    </div>
  );
}

/* ── SevFilter — All/High/Med/Low pill row ─────────────────── */
export function SevFilter({ value, onChange }) {
  const defs = [['all', 'All'], ['high', 'High'], ['med', 'Med'], ['low', 'Low']];
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {defs.map(([id, label]) => {
        const active = value === id;
        const tone = id === 'high' ? 'var(--bad-fg)' : id === 'med' ? 'var(--warn-fg)' : id === 'low' ? 'var(--info-fg)' : 'var(--t2)';
        return (
          <button key={id} onClick={() => onChange && onChange(id)}
            style={{ fontFamily: 'var(--f-display)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', padding: '4px 9px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${active ? 'var(--border-2)' : 'transparent'}`,
              background: active ? 'var(--surface-2)' : 'transparent',
              color: active ? tone : 'var(--t4)' }}>{label}</button>
        );
      })}
    </div>
  );
}

/* ── Tabs — underline tab strip with live counts ───────────── */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
      marginBottom: 14, overflowX: 'auto' }}>
      {tabs.map(t => {
        const active = value === t.id;
        return (
          <button key={t.id} onClick={() => onChange && onChange(t.id)}
            style={{ background: 'none', border: 'none', borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1, padding: '9px 14px', cursor: 'pointer',
              color: active ? 'var(--t1)' : 'var(--t3)', fontFamily: 'var(--f-ui)',
              fontWeight: active ? 700 : 500, fontSize: 13, display: 'flex', alignItems: 'center', gap: 7,
              whiteSpace: 'nowrap' }}>
            {t.label}
            {t.count != null && (
              <span className="num" style={{ fontSize: 10, background: active ? 'var(--accent-bg)' : 'var(--surface-2)',
                color: active ? 'var(--accent)' : 'var(--t4)', borderRadius: 99, padding: '0 6px' }}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── ToneBadge — generic semantic pill ─────────────────────── */
const TONES = {
  ok:   { fg: 'var(--ok-fg)',   bg: 'var(--ok-bg)',    bd: 'var(--ok-bd)' },
  warn: { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)',  bd: 'var(--warn-bd)' },
  bad:  { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',   bd: 'var(--bad-bd)' },
  info: { fg: 'var(--info-fg)', bg: 'var(--info-bg)',  bd: 'var(--info-bd)' },
  mute: { fg: 'var(--t2)',      bg: 'var(--surface-3)', bd: 'var(--border-2)' },
};
export function ToneBadge({ tone = 'mute', children, style }) {
  const t = TONES[tone] || TONES.mute;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'var(--f-display)',
      fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: t.fg, background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 5, padding: '2px 8px',
      whiteSpace: 'nowrap', ...style }}>{children}</span>
  );
}

/* ── StagePill — neutral mono stage chip (queue table) ─────── */
export function StagePill({ stage }) {
  return (
    <span className="num" style={{ fontSize: 11, color: 'var(--t2)', background: 'var(--surface-2)',
      borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap' }}>
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}

/* ── ExceptionRow — drill row used in the Overview feed ────── */
export function ExceptionRow({ ex, onClick }) {
  const p = sevPalette(ex.sev);
  const [hover, setHover] = useState(false);
  const isAll = !ex.dept || ex.dept === 'ALL';
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 13px',
        borderRadius: 'var(--radius-sm)', cursor: onClick ? 'pointer' : 'default',
        border: '1px solid', borderColor: hover ? 'var(--border-2)' : 'transparent',
        background: hover ? 'var(--surface-2)' : 'transparent', transition: 'all var(--fast) var(--ease)' }}>
      <div style={{ width: 34, height: 34, borderRadius: 'var(--radius-sm)', flexShrink: 0,
        display: 'grid', placeItems: 'center', background: p.bg, color: p.fg, border: `1px solid ${p.bd}` }}>
        <Icon name={ex.icon} size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--f-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', flexShrink: 0, borderRadius: 4, padding: '1px 6px',
            color: isAll ? 'var(--t4)' : 'var(--accent)',
            background: isAll ? 'var(--surface-3)' : 'var(--accent-bg)' }}>{ex.dept || 'ALL'}</span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.title}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.detail}</div>
      </div>
      <span className="num" style={{ fontWeight: 700, fontSize: 16, color: p.fg, flexShrink: 0 }}>{ex.metric}</span>
      <Icon name="chevR" size={15} style={{ color: 'var(--t4)' }} />
    </div>
  );
}

/* ── Drawer — right-slide drill-down surface ───────────────── */
export function Drawer({ open, onClose, width = 440, children }) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 40,
        animation: 'pit-fade .2s ease' }} />
      <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width, maxWidth: '92vw', zIndex: 41,
        background: 'var(--surface)', borderLeft: '1px solid var(--border-2)',
        boxShadow: '-20px 0 60px -20px rgba(0,0,0,.6)', display: 'flex', flexDirection: 'column',
        animation: 'pit-drawer .26s var(--ease)' }}>
        {children}
      </aside>
    </>
  );
}

/* ════════════════════════════════════════════════════════════
   Stepper — renders ONLY the disposition's legal path.
   current = accent (yellow dot + ring) · done = ok-green ·
   future = surface-3 ghost. variant 'spine' (default dotted
   nodes) | 'rail' (segmented battery bars). (handoff §6.3)
   ════════════════════════════════════════════════════════════ */
export function Stepper({ disposition, stage, variant = 'spine' }) {
  const stages = lifecycle(disposition);
  const curIdx = stages.indexOf(stage);
  const nodes = stages.map((s, i) => {
    const done = i < curIdx, current = i === curIdx;
    return {
      key: s, label: STAGE_LABEL[s] || s, done, current,
      dotBg: done ? 'var(--ok-fg)' : current ? 'var(--accent)' : 'var(--surface-3)',
      dotRing: current ? '0 0 0 4px var(--accent-ring)' : 'none',
      segBg: done ? 'var(--ok-fg)' : current ? 'var(--accent)' : 'var(--surface-3)',
      textColor: current ? 'var(--t1)' : done ? 'var(--t2)' : 'var(--t4)',
      textWeight: current ? 700 : 500,
    };
  });

  if (variant === 'rail') {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
        {nodes.map(n => (
          <div key={n.key} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ height: 7, borderRadius: 99, background: n.segBg }} />
            <div style={{ fontFamily: 'var(--f-ui)', fontSize: 9.5, color: n.textColor, fontWeight: n.textWeight,
              marginTop: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.label}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 4 }}>
      {nodes.map(n => (
        <div key={n.key} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '0 4px', width: 78 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: n.dotBg, boxShadow: n.dotRing }} />
            <div style={{ fontFamily: 'var(--f-ui)', fontSize: 10, textAlign: 'center', lineHeight: 1.2,
              color: n.textColor, fontWeight: n.textWeight }}>{n.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── StepperToggle — Spine / Rail style switch ─────────────── */
export function StepperToggle({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surface-2)', borderRadius: 6 }}>
      {[['spine', 'Spine'], ['rail', 'Rail']].map(([id, label]) => {
        const active = value === id;
        return (
          <button key={id} onClick={() => onChange && onChange(id)}
            style={{ fontFamily: 'var(--f-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
              textTransform: 'uppercase', padding: '4px 9px', borderRadius: 5, border: 'none', cursor: 'pointer',
              background: active ? 'var(--surface-3)' : 'transparent',
              color: active ? 'var(--t1)' : 'var(--t4)' }}>{label}</button>
        );
      })}
    </div>
  );
}

/* ── LiveDot — pulsing "Live · upd h:mm" status (topbar) ───── */
export function LiveDot({ refreshing, updated }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--f-mono)',
      fontSize: 10.5, color: 'var(--t3)', whiteSpace: 'nowrap' }}>
      <span className={refreshing ? '' : 'pit-pulse'} style={{ width: 7, height: 7, borderRadius: '50%',
        background: refreshing ? 'var(--warn-fg)' : 'var(--ok-fg)' }} />
      <span>{refreshing ? 'Sync…' : `Live${updated ? ` · upd ${updated}` : ''}`}</span>
    </div>
  );
}

/* ── shared inline-style objects ───────────────────────────── */
export const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
  borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontFamily: 'var(--f-display)',
  fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase',
  cursor: 'pointer', boxShadow: 'var(--accent-glow)', whiteSpace: 'nowrap',
};
export const btnGhost = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border-2)',
  borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontFamily: 'var(--f-ui)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
export const inputStyle = {
  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  padding: '9px 11px', color: 'var(--t1)', fontFamily: 'var(--f-ui)', fontSize: 13,
  outline: 'none', width: '100%', colorScheme: 'dark', accentColor: 'var(--accent)',
};
export const selectStyle = {
  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  padding: '9px 10px', color: 'var(--t2)', fontFamily: 'var(--f-ui)', fontSize: 13,
  cursor: 'pointer', outline: 'none', colorScheme: 'dark',
};
