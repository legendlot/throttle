'use client';
// ⌘K command palette (handoff §4) — the intended primary navigation.
// Fuzzy search across screens, entities (campaigns, journeys, segments,
// templates), and quick actions. Runs FULLY client-side over the existing
// list RPCs (§9: no backend search endpoint needed) — entity lists are
// fetched lazily when the palette opens and cached for a minute.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { garageFetch } from '@throttle/db';
import {
  Search, Send, GitBranch, Filter, Mail, Plus, SearchX,
} from 'lucide-react';

const ENTITY_TTL_MS = 60_000;

// Simple subsequence fuzzy match — every query char must appear in order.
function fuzzy(hay, q) {
  if (!q) return true;
  const h = String(hay || '').toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export function CommandPalette({ open, onClose, groups, onNav, session, perms }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [entities, setEntities] = useState({ campaigns: [], journeys: [], segments: [], templates: [] });
  const inputRef = useRef(null);
  const cacheRef = useRef({ at: 0 });

  // Lazy entity load on open (cached briefly so re-opening is instant).
  useEffect(() => {
    if (!open || !session) return;
    setQ(''); setSel(0);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 10);
    if (Date.now() - cacheRef.current.at < ENTITY_TTL_MS) return;
    let dead = false;
    (async () => {
      const [cs, js, sg, tp] = await Promise.all([
        garageFetch('getCampaigns', {}, session).catch(() => []),
        garageFetch('getJourneys', {}, session).catch(() => []),
        garageFetch('getSegments', {}, session).catch(() => []),
        garageFetch('getTemplates', {}, session).catch(() => []),
      ]);
      if (dead) return;
      cacheRef.current.at = Date.now();
      setEntities({
        campaigns: Array.isArray(cs) ? cs : [],
        journeys: Array.isArray(js) ? js : [],
        segments: Array.isArray(sg) ? sg : [],
        templates: Array.isArray(tp) ? tp : [],
      });
    })();
    return () => { dead = true; };
  }, [open, session]);

  // Screens from the (already perm-filtered) nav groups.
  const screens = useMemo(() => {
    const out = [];
    for (const g of groups || []) {
      if (g.flat) out.push({ label: g.label, route: g.route, icon: g.icon, sub: 'screen' });
      else for (const it of g.items || []) out.push({ label: it.label, route: it.route, icon: it.icon, sub: g.label });
    }
    return out;
  }, [groups]);

  const canBuild = !perms || perms.campaign_build;
  const canSeg = !perms || perms.segment_manage;
  const canTpl = !perms || perms.template_manage;
  const actions = useMemo(() => [
    canBuild && { label: 'New campaign', route: '/campaigns?new=1', icon: Plus },
    canBuild && { label: 'New journey', route: '/journeys?new=1', icon: Plus },
    canSeg && { label: 'New segment', route: '/segments?new=1', icon: Plus },
    canTpl && { label: 'New template', route: '/templates?new=1', icon: Plus },
  ].filter(Boolean), [canBuild, canSeg, canTpl]);

  const rows = useMemo(() => {
    const out = [];
    for (const s of screens) if (fuzzy(s.label, q)) out.push({ kind: 'Screens', label: s.label, sub: s.sub, route: s.route, icon: s.icon });
    for (const a of actions) if (fuzzy(a.label, q)) out.push({ kind: 'Actions', label: a.label, sub: 'action', route: a.route, icon: a.icon });
    // Entities only surface once the user types — an empty query stays a nav list.
    if (q.trim().length >= 2) {
      for (const c of entities.campaigns) if (fuzzy(c.name, q)) out.push({ kind: 'Campaigns', label: c.name, sub: `${c.channel || ''} · ${c.status || ''}`, route: '/campaigns', icon: Send });
      for (const j of entities.journeys) if (fuzzy(j.name, q)) out.push({ kind: 'Journeys', label: j.name, sub: j.status || '', route: '/journeys', icon: GitBranch });
      for (const s of entities.segments) if (fuzzy(s.name, q)) out.push({ kind: 'Segments', label: s.name, sub: s.kind || '', route: '/segments', icon: Filter });
      for (const t of entities.templates) if (fuzzy(t.name, q)) out.push({ kind: 'Templates', label: t.name, sub: `${t.channel || ''} · v${t.version ?? 1}`, route: '/templates', icon: Mail });
    }
    return out.slice(0, 40);
  }, [screens, actions, entities, q]);

  const go = useCallback((row) => {
    if (!row) return;
    onClose();
    onNav(row.route);
  }, [onClose, onNav]);

  // Keyboard: arrows move, enter goes, esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, rows, sel, go, onClose]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  // Group rows by kind for headed sections.
  const grouped = [];
  for (const r of rows) {
    let g = grouped[grouped.length - 1];
    if (!g || g.kind !== r.kind) { g = { kind: r.kind, rows: [] }; grouped.push(g); }
    g.rows.push(r);
  }
  let flat = -1;

  return (
    <div className="ck-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ck" role="dialog" aria-label="Command palette">
        <div className="ck-head">
          <Search size={17} style={{ color: '#6f747b', flexShrink: 0 }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search screens, campaigns, journeys, segments, templates…" />
          <kbd className="ck-esc">esc</kbd>
        </div>
        <div className="ck-body">
          {rows.length === 0 && (
            <div className="ck-empty"><SearchX size={17} style={{ color: 'var(--t4)' }} /> Nothing matches “{q}”.</div>
          )}
          {grouped.map((g) => (
            <div key={g.kind}>
              <div className="ck-glabel">{g.kind}</div>
              {g.rows.map((r) => {
                flat += 1;
                const idx = flat;
                const RIcon = r.icon || Search;
                return (
                  <button key={`${g.kind}-${r.label}-${idx}`}
                    className={`ck-row ${idx === sel ? 'sel' : ''}`}
                    onMouseEnter={() => setSel(idx)}
                    onClick={() => go(r)}>
                    <span className="ck-ico"><RIcon size={15} strokeWidth={1.75} /></span>
                    <span className="ck-main">{r.label}</span>
                    <span className="ck-sec">{r.sub}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
