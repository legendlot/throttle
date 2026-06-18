'use client';
// Manifest "Pit Wall" — Sidebar, Topbar, Tweaks panel.
import React, { useState } from 'react';
import { ChevronsLeft, ChevronsRight, Search, ArrowLeftRight, Sliders, Check } from 'lucide-react';
import { NAV, activeNav, CRUMB, ACCENTS } from './nav.js';
import { MONO, DISP } from './ui.js';

const initials = (s) => (s || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ── Sidebar ──────────────────────────────────────────────────────
export function Sidebar({ collapsed, onToggle, screen, onNav, badges = {}, fx, me }) {
  const active = activeNav(screen);
  return (
    <aside style={{ width: collapsed ? 76 : 244, flexShrink: 0, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
      transition: 'width .18s ease', overflow: 'hidden' }}>
      {/* header / toggle */}
      <div className="mf-sidehdr" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}
        style={{ height: 66, flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between', gap: 10,
          padding: collapsed ? 0 : '0 14px', borderBottom: '1px solid var(--border)' }}>
        {collapsed ? (
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ChevronsRight size={18} color="var(--accent-fg)" strokeWidth={2.2} />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <img src="/favicon.svg" alt="Manifest" width={30} height={30}
                style={{ borderRadius: 8, flexShrink: 0, display: 'block' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, letterSpacing: '.07em', color: 'var(--t1)' }}>MANIFEST</span>
                  <span style={{ width: 6, height: 15, background: 'var(--accent)', display: 'inline-block', animation: 'mfblink 1.1s steps(1) infinite' }} />
                </div>
                <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.18em', color: 'var(--t3)', marginTop: 2, whiteSpace: 'nowrap' }}>LOT × SOLVE FACTORY</div>
              </div>
            </div>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--surface2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ChevronsLeft size={15} color="var(--t3)" />
            </div>
          </>
        )}
      </div>

      {/* nav body */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        {NAV.map((row, i) => {
          if (row.needs && !row.needs(me?.permissions)) return null;
          if (row.kind === 'section') {
            return collapsed
              ? <div key={i} style={{ height: 1, background: 'var(--border)', margin: '0 8px 10px' }} />
              : <div key={i} style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: '.14em',
                  textTransform: 'uppercase', color: 'var(--t3)', padding: '14px 11px 7px' }}>// {row.label}</div>;
          }
          const Icon = row.icon;
          const isActive = active === row.id;
          const badge = badges[row.id];
          return (
            <div key={i} className={'mf-navrow' + (isActive ? ' active' : '')} title={collapsed ? row.label : undefined}
              onClick={() => onNav(row.id)}
              style={{ position: 'relative', display: 'flex', alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'flex-start', gap: 11,
                padding: collapsed ? '11px 0' : '9px 11px', borderRadius: 9, marginBottom: 2, cursor: 'pointer',
                fontFamily: DISP, fontSize: 13.5, fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--t1)' : 'var(--t2)',
                borderLeft: '3px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
                background: isActive ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent' }}>
              <Icon size={17} strokeWidth={1.7} color={isActive ? 'var(--accent)' : 'var(--t3)'} style={{ flexShrink: 0 }} />
              {!collapsed && <span style={{ flex: 1 }}>{row.label}</span>}
              {!collapsed && badge > 0 && (
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                  background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>{badge}</span>
              )}
              {collapsed && badge > 0 && (
                <span style={{ position: 'absolute', top: 7, right: 9, width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }} />
              )}
            </div>
          );
        })}
      </nav>

      {/* footer */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: collapsed ? '12px 0' : '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10, alignItems: collapsed ? 'center' : 'stretch' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--surface2)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: MONO, fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{initials(me?.full_name)}</div>
          {!collapsed && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: DISP, fontSize: 13, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me?.full_name || 'Manifest'}</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)' }}>{me ? `${me.party || 'LOT'} · ${me.manifest_role || ''}` : '—'}</div>
            </div>
          )}
        </div>
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 9.5, color: 'var(--green)', letterSpacing: '.05em' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--green)', animation: 'mfpulse 2s infinite' }} />
            SYNC OK · CNY/INR {fx ?? '—'}
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Topbar ───────────────────────────────────────────────────────
export function Topbar({ screen, fx }) {
  const c = CRUMB[screen] || { eyebrow: '', title: '' };
  return (
    <header style={{ height: 66, flexShrink: 0, display: 'flex', alignItems: 'center',
      padding: '0 28px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.16em', color: 'var(--t3)', marginBottom: 2 }}>{c.eyebrow}</div>
        <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 21, letterSpacing: '.01em', color: 'var(--t1)' }}>{c.title}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '7px 11px', fontFamily: MONO, fontSize: 11, color: 'var(--t3)', minWidth: 180 }}>
          <Search size={13} />
          <span style={{ flex: 1 }}>Search</span>
          <span style={{ fontSize: 10, color: 'var(--t3)' }}>⌘K</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, padding: '7px 11px',
          background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 26%, transparent)',
          fontFamily: MONO, fontSize: 11, fontWeight: 600, color: 'var(--t2)' }}>
          <span>LOT</span>
          <ArrowLeftRight size={13} color="var(--t3)" />
          <span>SF</span>
          <span style={{ borderLeft: '1px solid color-mix(in srgb, var(--accent) 26%, transparent)', paddingLeft: 8, color: 'var(--accent)' }}>{fx ?? '—'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--green)', letterSpacing: '.08em' }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--green)', animation: 'mfpulse 2s infinite' }} />
          LIVE
        </div>
      </div>
    </header>
  );
}

// ── Tweaks panel (accent + density) ──────────────────────────────
export function Tweaks({ accent, setAccent, density, setDensity }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 60 }}>
      {open && (
        <div style={{ position: 'absolute', right: 0, bottom: 52, width: 220, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', padding: 16 }}>
          <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 10 }}>Accent</div>
          <div style={{ display: 'flex', gap: 9, marginBottom: 18 }}>
            {ACCENTS.map((c) => (
              <button key={c} onClick={() => setAccent(c)} title={c}
                style={{ width: 30, height: 30, borderRadius: 8, background: c, cursor: 'pointer',
                  border: '2px solid ' + (accent === c ? 'var(--t1)' : 'transparent'),
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {accent === c && <Check size={15} color="#161519" strokeWidth={3} />}
              </button>
            ))}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 10 }}>Density</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['comfortable', 'compact'].map((d) => (
              <button key={d} onClick={() => setDensity(d)} className="mf-chip"
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontFamily: MONO, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em',
                  background: density === d ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--surface2)',
                  border: '1px solid ' + (density === d ? 'color-mix(in srgb, var(--accent) 32%, transparent)' : 'var(--border)'),
                  color: density === d ? 'var(--accent)' : 'var(--t2)' }}>{d}</button>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} className="mf-icobtn" title="Tweaks"
        style={{ width: 44, height: 44, borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Sliders size={18} color="var(--t2)" />
      </button>
    </div>
  );
}
