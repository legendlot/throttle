'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import {
  BookOpen, Search, Download, ChevronRight, ChevronLeft,
  Menu, X, FileText,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════════════
   Manual — the in-app interactive system manual viewer.

   One shared component, themed entirely through each app's CSS variables
   (--surface / --t1 / --accent / --mono …), so it adopts every system's
   design language automatically. Renders the same semantic content
   fragments (.lead / .callout / .steps / .tbl / .glance / .anatomy …)
   the PDF build uses — print-themed there, screen-themed here.

   Props:
     manual = {
       title, title_accent, subtitle, version, date, app_url, owner,
       pdf,                              // "/manual/<App>-Operations-Manual.pdf"
       roles: { key: {label, name, desc} },
       parts: [ { part, subtitle, chapters: [ {id,title,route,roles,html} ] } ]
     }
   ════════════════════════════════════════════════════════════════════ */

// Generic role-badge palette, assigned by role-key order so any app's role
// set (op/sup/dis/adm · mkt/lead/adm · agt/lead/adm …) gets distinct colours.
const ROLE_TINTS = [
  { fg: '#4ade80', bg: 'rgba(34,197,94,0.13)',  bd: 'rgba(34,197,94,0.4)'  }, // green
  { fg: '#7b93ff', bg: 'rgba(33,60,226,0.18)',  bd: 'rgba(123,147,255,0.4)' }, // blue
  { fg: '#fbbf24', bg: 'rgba(251,191,36,0.13)', bd: 'rgba(251,191,36,0.4)' }, // amber
  { fg: '#ff7a7a', bg: 'rgba(222,42,42,0.15)',  bd: 'rgba(222,42,42,0.45)' }, // red
  { fg: '#c084fc', bg: 'rgba(168,85,247,0.15)', bd: 'rgba(168,85,247,0.4)' }, // purple
  { fg: '#2dd4bf', bg: 'rgba(45,212,191,0.13)', bd: 'rgba(45,212,191,0.4)' }, // teal
];

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
}

export function Manual({ manual, bleed = true }) {
  const parts = manual?.parts || [];
  const roleDefs = manual?.roles || {};
  const roleKeys = Object.keys(roleDefs);
  const roleTint = useMemo(() => {
    const m = {};
    roleKeys.forEach((k, i) => { m[k] = ROLE_TINTS[i % ROLE_TINTS.length]; });
    return m;
  }, [roleKeys.join(',')]);

  // Flatten chapters (with their part) for prev/next + lookup.
  const flat = useMemo(() => {
    const out = [];
    parts.forEach((p) => (p.chapters || []).forEach((c) => out.push({ ...c, part: p.part })));
    return out;
  }, [manual]);

  const [activeId, setActiveId] = useState(flat[0]?.id || null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState(null); // null = all
  const [navOpen, setNavOpen] = useState(false);       // mobile drawer
  const contentRef = useRef(null);

  // Deep-link: read hash on mount, write hash on change.
  useEffect(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    if (h && flat.some((c) => c.id === h)) setActiveId(h);
  }, []); // eslint-disable-line

  const active = flat.find((c) => c.id === activeId) || flat[0];
  const activeIdx = flat.findIndex((c) => c.id === active?.id);
  const prev = activeIdx > 0 ? flat[activeIdx - 1] : null;
  const next = activeIdx >= 0 && activeIdx < flat.length - 1 ? flat[activeIdx + 1] : null;

  const q = query.trim().toLowerCase();
  function chapterVisible(c) {
    if (roleFilter && !(c.roles || []).includes(roleFilter)) return false;
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      (c.route || '').toLowerCase().includes(q) ||
      stripTags(c.html).toLowerCase().includes(q)
    );
  }
  const visibleParts = parts
    .map((p) => ({ ...p, chapters: (p.chapters || []).filter(chapterVisible) }))
    .filter((p) => p.chapters.length);
  const matchCount = visibleParts.reduce((n, p) => n + p.chapters.length, 0);

  function go(id) {
    setActiveId(id);
    setNavOpen(false);
    if (typeof window !== 'undefined') {
      try { window.history.replaceState(null, '', `#${id}`); } catch (_) {}
    }
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  function RoleBadges({ ids, size = 'sm' }) {
    return (ids || []).map((r) => {
      const def = roleDefs[r];
      if (!def) return null;
      const t = roleTint[r] || ROLE_TINTS[0];
      return (
        <span key={r} className="man-role" style={{ color: t.fg, background: t.bg, borderColor: t.bd, fontSize: size === 'lg' ? 11 : 9.5 }}>
          {def.label}
        </span>
      );
    });
  }

  if (!active) {
    return <div style={{ padding: 40, color: 'var(--t3,#888)', fontFamily: 'var(--mono,monospace)' }}>Manual content not available.</div>;
  }

  return (
    <div className={`man-root${bleed ? '' : ' man-root-flush'}`}>
      <style>{STYLE}</style>

      {/* ── Index rail ─────────────────────────────────────────── */}
      <aside className={`man-rail${navOpen ? ' man-rail-open' : ''}`}>
        <div className="man-rail-head">
          <div className="man-brand">
            <BookOpen size={16} strokeWidth={2} className="man-brand-icon" />
            <div>
              <div className="man-brand-title">{manual.title} <span>Manual</span></div>
              <div className="man-brand-ver">v{manual.version} · {manual.date}</div>
            </div>
          </div>
          <button className="man-rail-close" onClick={() => setNavOpen(false)} aria-label="Close"><X size={16} /></button>
        </div>

        <a className="man-dl" href={manual.pdf} target="_blank" rel="noopener noreferrer" download>
          <Download size={14} strokeWidth={2.2} /> <span>Download PDF</span>
        </a>

        <div className="man-search">
          <Search size={14} className="man-search-icon" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the manual…"
            spellCheck={false}
          />
          {query && <button className="man-search-clear" onClick={() => setQuery('')} aria-label="Clear"><X size={13} /></button>}
        </div>

        {roleKeys.length > 0 && (
          <div className="man-roles">
            <button
              className={`man-rolechip${!roleFilter ? ' on' : ''}`}
              onClick={() => setRoleFilter(null)}
            >All</button>
            {roleKeys.map((r) => {
              const t = roleTint[r];
              const on = roleFilter === r;
              return (
                <button
                  key={r}
                  className={`man-rolechip${on ? ' on' : ''}`}
                  onClick={() => setRoleFilter(on ? null : r)}
                  style={on ? { color: t.fg, background: t.bg, borderColor: t.bd } : undefined}
                  title={roleDefs[r]?.desc || roleDefs[r]?.name}
                >{roleDefs[r]?.label || r}</button>
              );
            })}
          </div>
        )}

        <nav className="man-toc">
          {q && <div className="man-toc-count">{matchCount} match{matchCount === 1 ? '' : 'es'}</div>}
          {visibleParts.length === 0 && (
            <div className="man-toc-empty">No chapters match “{query}”.</div>
          )}
          {visibleParts.map((p) => (
            <div key={p.part} className="man-toc-part">
              <div className="man-toc-partlabel">{p.part}</div>
              {p.chapters.map((c) => (
                <button
                  key={c.id}
                  className={`man-toc-ch${c.id === active.id ? ' on' : ''}`}
                  onClick={() => go(c.id)}
                >
                  <span className="man-toc-chtitle">{c.title}</span>
                  {c.route && <span className="man-toc-chroute">{c.route}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {navOpen && <div className="man-scrim" onClick={() => setNavOpen(false)} />}

      {/* ── Content ────────────────────────────────────────────── */}
      <div className="man-main" ref={contentRef}>
        <div className="man-mobilebar">
          <button className="man-menu" onClick={() => setNavOpen(true)}><Menu size={16} /> Contents</button>
          <a className="man-dl-sm" href={manual.pdf} target="_blank" rel="noopener noreferrer" download><Download size={14} /> PDF</a>
        </div>

        <article className="man-article">
          <div className="man-crumb">
            <span>{active.part}</span><ChevronRight size={12} /><span className="man-crumb-cur">{active.title}</span>
          </div>
          <h1 className="man-h1">{active.title}</h1>
          <div className="man-meta">
            {active.route && <span className="man-route"><FileText size={12} /> {active.route}</span>}
            <RoleBadges ids={active.roles} size="lg" />
          </div>

          <div className="man-body" dangerouslySetInnerHTML={{ __html: active.html || '' }} />

          <div className="man-pager">
            {prev ? (
              <button className="man-pg" onClick={() => go(prev.id)}>
                <ChevronLeft size={15} />
                <span><em>Previous</em><b>{prev.title}</b></span>
              </button>
            ) : <span />}
            {next ? (
              <button className="man-pg man-pg-next" onClick={() => go(next.id)}>
                <span><em>Next</em><b>{next.title}</b></span>
                <ChevronRight size={15} />
              </button>
            ) : <span />}
          </div>
        </article>
      </div>
    </div>
  );
}

const STYLE = `
.man-root {
  --man-accent: var(--accent, var(--yellow, #F2CD1A));
  display: flex; gap: 0; height: 100%;
  margin: -16px -24px; /* bleed to the edges of the standard page <main> padding (16px 24px) */
  font-family: var(--mono, ui-monospace, monospace);
  color: var(--t1, #f5f5f5);
}
.man-root.man-root-flush { margin: 0; } /* caller provides its own sized/bled container */

/* ── Index rail ─────────────────────────────────────────────── */
.man-rail {
  width: 296px; flex-shrink: 0; height: 100%;
  display: flex; flex-direction: column;
  background: var(--surface, #2a2a2a); border-right: 1px solid var(--border, #404040);
  overflow: hidden;
}
.man-rail-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 16px 12px; border-bottom: 1px solid var(--border, #404040);
}
.man-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.man-brand-icon { color: var(--man-accent); flex-shrink: 0; }
.man-brand-title {
  font-family: var(--cond, var(--mono)); font-weight: 700; font-size: 15px;
  letter-spacing: 0.04em; color: var(--t1, #f5f5f5); white-space: nowrap;
}
.man-brand-title span { color: var(--t3, #888); font-weight: 400; }
.man-brand-ver { font-size: 10.5px; color: var(--t3, #888); margin-top: 2px; letter-spacing: 0.02em; }
.man-rail-close { display: none; background: none; border: none; color: var(--t3,#888); cursor: pointer; padding: 4px; }

.man-dl {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  margin: 12px 16px 4px; padding: 9px 12px;
  background: var(--man-accent); color: var(--accent-fg, #0a0a0a);
  border-radius: 6px; font-size: 12.5px; font-weight: 700; letter-spacing: 0.03em;
  text-decoration: none; cursor: pointer;
  transition: filter 120ms;
}
.man-dl:hover { filter: brightness(1.08); }

.man-search {
  position: relative; margin: 12px 16px 4px;
  display: flex; align-items: center;
}
.man-search-icon { position: absolute; left: 10px; color: var(--t3,#888); pointer-events: none; }
.man-search input {
  width: 100%; background: var(--surface2, #333); border: 1px solid var(--border, #404040);
  border-radius: 6px; padding: 8px 28px 8px 32px; color: var(--t1,#f5f5f5);
  font-family: var(--mono, monospace); font-size: 12.5px; outline: none;
  transition: border-color 120ms;
}
.man-search input:focus { border-color: var(--man-accent); }
.man-search input::placeholder { color: var(--t3,#888); }
.man-search-clear { position: absolute; right: 8px; background: none; border: none; color: var(--t3,#888); cursor: pointer; padding: 2px; display: flex; }
.man-search-clear:hover { color: var(--t1,#f5f5f5); }

.man-roles { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 16px 6px; }
.man-rolechip {
  font-family: var(--mono, monospace); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.03em; padding: 3.5px 9px; border-radius: 999px; cursor: pointer;
  background: var(--surface2, #333); color: var(--t2, #b0b0b0);
  border: 1px solid var(--border, #404040); transition: color 120ms, border-color 120ms;
}
.man-rolechip:hover { color: var(--t1, #f5f5f5); border-color: var(--border2, #4a4a4a); }
.man-rolechip.on { color: var(--accent-fg, #0a0a0a); background: var(--man-accent); border-color: var(--man-accent); font-weight: 700; }

.man-toc { flex: 1; overflow-y: auto; padding: 6px 8px 24px; }
.man-toc::-webkit-scrollbar { width: 4px; }
.man-toc::-webkit-scrollbar-thumb { background: var(--border2, #4a4a4a); border-radius: 2px; }
.man-toc-count { font-size: 10px; color: var(--t3,#888); padding: 6px 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.man-toc-empty { font-size: 12px; color: var(--t3,#888); padding: 16px 8px; line-height: 1.5; }
.man-toc-part { margin-bottom: 6px; }
.man-toc-partlabel {
  font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--t3, #888); padding: 12px 8px 4px;
}
.man-toc-ch {
  display: flex; flex-direction: column; gap: 1px; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer; border-radius: 6px;
  padding: 7px 10px; color: var(--t2, #b0b0b0);
  border-left: 2px solid transparent;
  transition: color 120ms, background 120ms;
}
.man-toc-ch:hover { color: var(--t1, #f5f5f5); background: rgba(255,255,255,0.03); }
.man-toc-ch.on {
  color: var(--man-accent); background: color-mix(in srgb, var(--man-accent) 10%, transparent);
  border-left-color: var(--man-accent);
}
.man-toc-chtitle { font-size: 13px; font-weight: 500; line-height: 1.3; }
.man-toc-chroute { font-size: 10px; color: var(--t3, #888); }
.man-toc-ch.on .man-toc-chroute { color: color-mix(in srgb, var(--man-accent) 70%, var(--t3)); }

.man-scrim { display: none; }

/* ── Content column ─────────────────────────────────────────── */
.man-main { flex: 1; overflow-y: auto; background: var(--bg, #1f1f1f); }
.man-mobilebar { display: none; }
.man-article { max-width: 820px; margin: 0 auto; padding: 32px 40px 80px; }

.man-crumb {
  display: flex; align-items: center; gap: 5px; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.07em; color: var(--t3, #888); margin-bottom: 12px;
}
.man-crumb .man-crumb-cur { color: var(--t2, #b0b0b0); }
.man-h1 {
  font-family: var(--cond, var(--mono)); font-weight: 700; font-size: 32px;
  line-height: 1.1; letter-spacing: -0.01em; color: var(--t1, #f5f5f5);
}
.man-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 14px 0 4px; }
.man-route {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--mono, monospace); font-size: 12px; color: var(--t2, #b0b0b0);
  background: var(--surface, #2a2a2a); border: 1px solid var(--border, #404040);
  border-radius: 5px; padding: 3px 9px;
}
.man-role {
  display: inline-flex; align-items: center; font-family: var(--mono, monospace);
  font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap;
}

/* ── Pager ──────────────────────────────────────────────────── */
.man-pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border, #404040); }
.man-pg {
  display: flex; align-items: center; gap: 10px; max-width: 48%;
  background: var(--surface, #2a2a2a); border: 1px solid var(--border, #404040);
  border-radius: 8px; padding: 12px 16px; cursor: pointer; text-align: left;
  color: var(--t1, #f5f5f5); transition: border-color 120ms, background 120ms;
}
.man-pg:hover { border-color: var(--man-accent); background: var(--surface2, #333); }
.man-pg-next { margin-left: auto; text-align: right; }
.man-pg span { display: flex; flex-direction: column; min-width: 0; }
.man-pg em { font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--t3, #888); }
.man-pg b { font-size: 13px; font-weight: 600; color: var(--t1, #f5f5f5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.man-pg svg { flex-shrink: 0; color: var(--t3, #888); }
.man-pg:hover svg { color: var(--man-accent); }

/* ════════════════════════════════════════════════════════════
   Content body — the semantic fragment classes, screen-themed.
   Mirrors the print theme.css component set (.lead/.callout/.tbl/
   .steps/.glance/.anatomy/.stub …) but tuned for dark UI reading.
   ════════════════════════════════════════════════════════════ */
.man-body {
  font-family: var(--font-body, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  font-size: 15px; line-height: 1.68; color: var(--t2, #b0b0b0); margin-top: 22px;
}
.man-body p { margin: 0 0 14px; }
.man-body strong { color: var(--t1, #f5f5f5); font-weight: 600; }
.man-body em { font-style: italic; color: var(--t2, #b0b0b0); }
.man-body a { color: var(--state-info-fg, #7b93ff); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--state-info-fg, #7b93ff) 40%, transparent); }
.man-body a:hover { border-bottom-color: var(--state-info-fg, #7b93ff); }
.man-body ul, .man-body ol { margin: 0 0 16px; padding-left: 22px; }
.man-body li { margin-bottom: 7px; }
.man-body ul.tight li, .man-body ol.tight li { margin-bottom: 2px; }
.man-body code, .man-body .mono {
  font-family: var(--mono, ui-monospace, monospace); font-size: 0.86em;
  background: var(--surface, #2a2a2a); border: 1px solid var(--border, #404040);
  border-radius: 4px; padding: 1px 6px; color: var(--t1, #f5f5f5);
}
.man-body .kbd { font-family: var(--mono, monospace); font-size: 0.82em; background: var(--surface2,#333); border: 1px solid var(--border2,#4a4a4a); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; color: var(--t1,#f5f5f5); }

.man-body .lead { font-size: 17px; line-height: 1.6; color: var(--t1, #f5f5f5); margin-bottom: 22px; }

.man-body h2.sec {
  font-family: var(--cond, var(--mono)); font-weight: 700; font-size: 21px;
  color: var(--t1, #f5f5f5); margin: 34px 0 12px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #404040); letter-spacing: -0.005em;
}
.man-body h3.sub {
  font-family: var(--cond, var(--mono)); font-weight: 600; font-size: 16.5px;
  color: var(--t1, #f5f5f5); margin: 24px 0 8px;
}

/* role badges that appear inline inside fragments */
.man-body .role {
  display: inline-flex; align-items: center; font-family: var(--mono, monospace);
  font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border2, #4a4a4a);
  background: var(--surface2, #333); color: var(--t2, #b0b0b0); white-space: nowrap;
}

/* callouts — left accent bar + tinted surface */
.man-body .callout {
  border-radius: 8px; padding: 14px 16px; margin: 18px 0;
  background: var(--surface, #2a2a2a); border: 1px solid var(--border, #404040);
  border-left: 3px solid var(--border2, #4a4a4a);
}
.man-body .callout .c-title {
  font-family: var(--mono, monospace); font-size: 11px; font-weight: 700;
  letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 7px;
  display: flex; align-items: center; gap: 6px; color: var(--t2, #b0b0b0);
}
.man-body .callout p:last-child { margin-bottom: 0; }
.man-body .callout.note   { border-left-color: #7b93ff; background: rgba(33,60,226,0.08); }
.man-body .callout.note .c-title   { color: #9db0ff; }
.man-body .callout.tip    { border-left-color: #22c55e; background: rgba(34,197,94,0.07); }
.man-body .callout.tip .c-title    { color: #5fdb87; }
.man-body .callout.warn   { border-left-color: #fbbf24; background: rgba(251,191,36,0.08); }
.man-body .callout.warn .c-title   { color: #fcd34d; }
.man-body .callout.danger { border-left-color: #de2a2a; background: rgba(222,42,42,0.10); }
.man-body .callout.danger .c-title { color: #ff8a8a; }
.man-body .callout.floor  { border-left-color: var(--man-accent); background: color-mix(in srgb, var(--man-accent) 8%, transparent); }
.man-body .callout.floor .c-title  { color: var(--man-accent); }

/* tables */
.man-body table.tbl { width: 100%; border-collapse: collapse; margin: 16px 0 20px; font-size: 14px; }
.man-body table.tbl th {
  text-align: left; font-family: var(--mono, monospace); font-size: 11px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--t2, #b0b0b0);
  background: var(--surface2, #333); border-bottom: 1px solid var(--border2, #4a4a4a);
  padding: 10px 12px; vertical-align: bottom;
}
.man-body table.tbl td { padding: 10px 12px; border-bottom: 1px solid var(--border, #404040); vertical-align: top; color: var(--t2, #b0b0b0); }
.man-body table.tbl tr:nth-child(even) td { background: rgba(255,255,255,0.015); }
.man-body table.tbl td .mono, .man-body table.tbl td.mono { font-family: var(--mono, monospace); font-size: 0.88em; }

/* numbered steps */
.man-body ol.steps { list-style: none; padding-left: 0; counter-reset: step; margin: 18px 0; }
.man-body ol.steps > li {
  position: relative; padding-left: 40px; margin-bottom: 16px; counter-increment: step;
  min-height: 28px;
}
.man-body ol.steps > li::before {
  content: counter(step); position: absolute; left: 0; top: -2px;
  width: 27px; height: 27px; background: var(--man-accent); color: var(--accent-fg, #0a0a0a);
  font-family: var(--mono, monospace); font-weight: 700; font-size: 13px;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
}
.man-body ol.steps > li .s-title { font-weight: 600; color: var(--t1, #f5f5f5); }

/* at-a-glance card row */
.man-body .glance {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px; background: var(--border, #404040); border: 1px solid var(--border, #404040);
  border-radius: 8px; overflow: hidden; margin: 18px 0;
}
.man-body .glance .g-cell { padding: 12px 14px; background: var(--surface, #2a2a2a); }
.man-body .glance .g-lbl { font-family: var(--mono, monospace); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--t3, #888); margin-bottom: 6px; }
.man-body .glance .g-val { font-size: 13.5px; color: var(--t1, #f5f5f5); line-height: 1.4; }

/* field / anatomy reference */
.man-body .anatomy { border: 1px solid var(--border, #404040); border-radius: 8px; overflow: hidden; margin: 18px 0; }
.man-body .anatomy .a-row { display: flex; border-bottom: 1px solid var(--border, #404040); }
.man-body .anatomy .a-row:last-child { border-bottom: none; }
.man-body .anatomy .a-key {
  width: 168px; flex-shrink: 0; background: var(--surface, #2a2a2a); padding: 11px 14px;
  font-family: var(--mono, monospace); font-size: 13px; font-weight: 600; color: var(--t1, #f5f5f5);
  border-right: 1px solid var(--border, #404040);
}
.man-body .anatomy .a-val { padding: 11px 14px; flex: 1; }
.man-body .anatomy .a-val p:last-child { margin-bottom: 0; }

/* stub placeholder */
.man-body .stub { border: 1px dashed var(--border2, #4a4a4a); border-radius: 8px; padding: 28px; text-align: center; background: var(--surface, #2a2a2a); margin-top: 22px; }
.man-body .stub .stub-tag {
  font-family: var(--mono, monospace); font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase;
  color: #fcd34d; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.4);
  border-radius: 999px; padding: 4px 12px; display: inline-block; margin-bottom: 14px;
}
.man-body .stub p { color: var(--t2, #b0b0b0); max-width: 460px; margin: 0 auto 8px; }

.man-body img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border, #404040); margin: 16px 0; }
.man-body hr { border: none; border-top: 1px solid var(--border, #404040); margin: 28px 0; }

/* ── Responsive ─────────────────────────────────────────────── */
@media (max-width: 880px) {
  .man-rail {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 60;
    transform: translateX(-100%); transition: transform 220ms cubic-bezier(0.22,1,0.36,1);
    box-shadow: 0 0 40px rgba(0,0,0,0.5);
  }
  .man-rail.man-rail-open { transform: translateX(0); }
  .man-rail-close { display: block; }
  .man-scrim { display: block; position: fixed; inset: 0; z-index: 55; background: rgba(0,0,0,0.5); }
  .man-mobilebar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--border, #404040);
    position: sticky; top: 0; background: var(--bg, #1f1f1f); z-index: 10;
  }
  .man-menu, .man-dl-sm {
    display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono, monospace);
    font-size: 12.5px; font-weight: 600; background: var(--surface, #2a2a2a);
    border: 1px solid var(--border, #404040); border-radius: 6px; padding: 7px 12px;
    color: var(--t1, #f5f5f5); cursor: pointer; text-decoration: none;
  }
  .man-article { padding: 24px 20px 64px; }
  .man-h1 { font-size: 26px; }
  .man-pg { max-width: 49%; }
}
`;
