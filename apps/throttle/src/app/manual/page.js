'use client';
/* System Manual — section nav + article reader, searchable + deep-linkable
   (⌘K / throttle:manual). Ported verbatim from manual.jsx. */
import React, { useState, useEffect } from 'react';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card } from '@/components/throttle/ui';
import { MANUAL } from '@/lib/throttleData';

function secText(s) {
  return s.body.map(b => b.h || b.p || (b.steps ? b.steps.join(' ') : '') || (b.table ? b.table.flat().join(' ') : '')).join(' ').toLowerCase();
}

function ManualScreen() {
  const [active, setActive] = useState(MANUAL[0].id);
  const [q, setQ] = useState('');

  useEffect(() => {
    const open = id => { if (MANUAL.some(s => s.id === id)) { setActive(id); setQ(''); } };
    if (typeof window !== 'undefined' && window.__throttleManualSection) { open(window.__throttleManualSection); window.__throttleManualSection = null; }
    const onEvt = e => open(e.detail);
    window.addEventListener('throttle:manual', onEvt);
    return () => window.removeEventListener('throttle:manual', onEvt);
  }, []);

  const ql = q.trim().toLowerCase();
  const matches = ql ? MANUAL.filter(s => s.label.toLowerCase().includes(ql) || secText(s).includes(ql)) : MANUAL;
  const list = matches.length ? matches : MANUAL;
  const sec = list.find(s => s.id === active) || list[0];
  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gridTemplateColumns: '232px 1fr', gap: 28, alignItems: 'start' }}>
      <div style={{ position: 'sticky', top: 0 }}>
        <span className="eyebrow" style={{ padding: '0 0 10px', display: 'block' }}>System Manual</span>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--t4)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the manual…"
            style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px 8px 32px',
              color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {list.map(s => {
            const on = s.id === sec.id;
            return (
              <button key={s.id} onClick={() => setActive(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 12px',
                borderRadius: 'var(--r-sm)', cursor: 'pointer', border: 'none', textAlign: 'left', fontFamily: 'var(--font-ui)',
                borderLeft: `2px solid ${on ? 'var(--yellow)' : 'transparent'}`,
                background: on ? 'var(--active-bg)' : 'transparent', color: on ? 'var(--yellow)' : 'var(--t2)', transition: 'background .14s' }}
                onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                <Icon name={s.icon} size={16} style={{ color: on ? 'var(--yellow)' : 'var(--t3)' }} />
                <span style={{ fontSize: 13.5, fontWeight: on ? 600 : 500 }}>{s.label}</span>
              </button>
            );
          })}
          {ql && matches.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--t4)' }}>No match — showing all.</div>}
        </div>
      </div>

      <Card style={{ padding: '34px 40px 40px' }}>
        <span className="eyebrow" style={{ padding: 0, color: 'var(--yellow)' }}>{sec.label}</span>
        <article style={{ marginTop: 16, maxWidth: 620 }}>
          {sec.body.map((b, i) => {
            if (b.h) return <h2 key={i} className="t-h2" style={{ fontSize: 16, marginTop: i ? 28 : 0, marginBottom: 12 }}>{b.h}</h2>;
            if (b.p) return <p key={i} style={{ fontSize: 14.5, lineHeight: 1.7, color: 'var(--t2)', margin: '0 0 14px', textWrap: 'pretty' }}>{b.p}</p>;
            if (b.steps) return (
              <ol key={i} style={{ listStyle: 'none', counterReset: 'step', margin: '4px 0 16px', padding: 0 }}>
                {b.steps.map((s, j) => (
                  <li key={j} style={{ display: 'flex', gap: 13, alignItems: 'flex-start', padding: '7px 0' }}>
                    <span className="num" style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--surface-2)', border: '1px solid var(--border-2)',
                      display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--yellow)', flexShrink: 0, fontWeight: 600 }}>{j + 1}</span>
                    <span style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.5, paddingTop: 2 }}>{s}</span>
                  </li>
                ))}
              </ol>
            );
            if (b.table) return (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', margin: '6px 0 16px' }}>
                {b.table.map((row, j) => (
                  <div key={j} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', borderTop: j ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ padding: '11px 14px', background: 'var(--surface-2)', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700,
                      letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)' }}>{row[0]}</div>
                    <div style={{ padding: '11px 16px', fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.5 }}>{row[1]}</div>
                  </div>
                ))}
              </div>
            );
            return null;
          })}
        </article>
      </Card>
    </div>
  );
}

export default function ManualPage() {
  return <AppShell route="manual"><ManualScreen /></AppShell>;
}
