'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { Typeahead, Avatar, RatingDot, StagePill } from '../ui/index.js';
import { ignitionopsGet } from '../../lib/ignitionopsFetch.js';
import { searchAllGroups } from '../../lib/globalSearch.js';
import { isTypingTarget } from './IgRail.js';

// Global search in the top bar (plan 2026-10-08-ignition-typeahead-search §1A): influencers, deals and
// campaigns from the worker's searchAll; a pick opens the record. ⌘/Ctrl+K focuses it from any page
// (`/` still focuses the page's own box). ≤767px: a search icon opens a full-screen sheet instead.
// Connects are deliberately not here (no server-side name to match on — decided 2026-10-08).

// ignition.campaigns.status CHECK: active | completed | cancelled (same tones as the Campaigns grid).
const CAMPAIGN_TONE = { active: 'var(--state-success-fg)', completed: '#8ea2ff', cancelled: 'var(--text-3)' };

function decorate(groups) {
  return groups.map((g) => (g.error ? g : {
    ...g,
    items: g.items.map((it) => {
      if (it.kind === 'influencer') {
        return { ...it, lead: <Avatar name={it.primary} seed={it.id} size={28} />,
          meta: it.rating ? <RatingDot rating={it.rating} showLabel={false} /> : null };
      }
      if (it.kind === 'deal') {
        return { ...it, meta: <>
          {it.ugc && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '.06em' }}>UGC</span>}
          <StagePill stage={it.stage} ugc={it.ugc} />
        </> };
      }
      return { ...it, meta: it.status ? (
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
          color: CAMPAIGN_TONE[it.status] || 'var(--text-3)' }}>{it.status}</span>
      ) : null };
    }),
  }));
}

export default function GlobalSearch() {
  const router = useRouter();
  const { session } = useAuth();
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const deskRef = useRef(null);
  const mobRef = useRef(null);
  const [sheet, setSheet] = useState(false);
  // A route change (pick, browser back, Android back gesture) closes the phone sheet.
  const pathname = usePathname();
  useEffect(() => { setSheet(false); }, [pathname]);
  const closeSheet = useCallback(() => { setSheet(false); mobRef.current?.focus(); }, []);

  // "⌘K" on a Mac, "Ctrl K" elsewhere — read after mount so the static HTML and hydration agree.
  const [kbd, setKbd] = useState('⌘K');
  useEffect(() => {
    const p = navigator.userAgentData?.platform || navigator.platform || '';
    if (!/mac|iphone|ipad/i.test(p)) setKbd('Ctrl K');
  }, []);

  const fetchResults = useCallback(async (q, signal) => {
    const d = await ignitionopsGet('searchAll', { q }, sessionRef.current, { signal });
    return decorate(searchAllGroups(d));
  }, []);

  const onPick = useCallback((it) => {
    setSheet(false);
    deskRef.current?.blur();
    router.push(it.href);
  }, [router]);

  // ⌘/Ctrl+K → global search, from any page.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Never pull focus out of an open modal to the page behind it, and leave Ctrl+K (macOS
      // "delete to end of line") alone while typing in a field (S412 review). Our own sheet is the
      // exception: ⌘K there just refocuses its box (and keeps the browser's ⌘K from firing).
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal?.classList.contains('ig-gs-sheet')) {
        e.preventDefault();
        modal.querySelector('input')?.focus();
        return;
      }
      if (modal) return;
      if (e.ctrlKey && !e.metaKey && (isTypingTarget(e.target) || isTypingTarget(document.activeElement))) return;
      e.preventDefault();
      const desk = deskRef.current;
      if (desk && desk.offsetParent !== null) { desk.focus(); desk.select?.(); }
      else setSheet(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const common = {
    fetchResults, onPick, primary: false, autoHighlight: true, clearOnPick: true,
    placeholder: 'Search influencers, deals, campaigns', ariaLabel: 'Search Ignition',
  };

  return (
    <>
      <div className="ig-gs-desk" style={{ flex: 1, minWidth: 0, maxWidth: 560 }}>
        <Typeahead {...common} size="lg" width="100%" inputRef={deskRef}
          trailing={
            <span className="ig-topbar-kbd" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 8px',
              border: '1px solid var(--border-3)', borderRadius: 6, flexShrink: 0 }}>{kbd}</span>
          } />
      </div>

      <button ref={mobRef} type="button" className="ig-gs-mob ig-ghost-btn" onClick={() => setSheet(true)} aria-label="Search"
        style={{ width: 42, height: 42, borderRadius: 12, border: '1px solid var(--border-2)', background: 'var(--input)',
          color: 'var(--text-2)', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
        <Search size={18} strokeWidth={1.75} />
      </button>
      <span className="ig-gs-mob" style={{ flex: 1 }} />

      {sheet && <SearchSheet common={common} onClose={closeSheet} />}
    </>
  );
}

// Full-screen phone sheet: the same box, results listed in place under it.
function SearchSheet({ common, onClose }) {
  const [text, setText] = useState('');
  return (
    <div role="dialog" aria-modal="true" aria-label="Search" className="ig-gs-sheet"
      // Esc from anywhere in the sheet (the close button too) closes it once the box has nothing to undo.
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}
      style={{
        position: 'fixed', inset: 0, zIndex: 300, background: 'var(--bg)', display: 'flex', flexDirection: 'column',
        padding: 'calc(12px + env(safe-area-inset-top)) 12px 12px', gap: 10, fontFamily: 'var(--font-ui)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typeahead {...common} value={text} onChange={setText} size="lg" width="100%" autoFocus persistent
          style={{ flex: 1 }}
          dropdownStyle={{
            position: 'fixed', top: 'calc(70px + env(safe-area-inset-top))', left: 12, right: 12, bottom: 12,
            maxHeight: 'none', animation: 'none',
          }} />
        <button type="button" onClick={onClose} aria-label="Close search" className="ig-ghost-btn"
          style={{ width: 42, height: 42, flexShrink: 0, borderRadius: 12, border: '1px solid var(--border-2)',
            background: 'transparent', color: 'var(--text-2)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer' }}>
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>
      {!text && (
        <p style={{ margin: '8px 4px', fontSize: 13, color: 'var(--text-3)' }}>
          Find an influencer by name, handle, code or phone; a deal by number, tracking id or video link; or a campaign by name.
        </p>
      )}
    </div>
  );
}
