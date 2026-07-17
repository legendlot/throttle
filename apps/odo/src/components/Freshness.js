'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { salesGet } from '../lib/api.js';
import { scopeForRoute, summarize, ago, shortAge, TONE_COLOR } from '../lib/freshness.js';

// One getFreshness call for the whole app, held in the layout — every page gets its stamp free.
const Ctx = createContext({ feeds: [], manual: {}, loading: true });
export const useFreshness = () => useContext(Ctx);

const POLL_MS = 5 * 60 * 1000;   // feeds move on an hourly cron — 5 min is plenty
const TICK_MS = 30 * 1000;       // re-render relative labels so they never look frozen

export function FreshnessProvider({ children }) {
  const { session } = useAuth();
  const [state, setState] = useState({ feeds: [], manual: {}, loading: true });

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const load = () => salesGet('getFreshness', {}, session)
      .then(d => { if (alive) setState({ feeds: d?.feeds || [], manual: d?.manual || {}, loading: false }); })
      .catch(() => { if (alive) setState(s => ({ ...s, loading: false })); });   // never break the shell
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [session]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function FreshnessChip() {
  const { feeds, manual, loading } = useFreshness();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const boxRef = useRef(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(t); }, []);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const sum = useMemo(() => summarize(scopeForRoute(pathname, feeds, manual), now), [pathname, feeds, manual, now]);

  if (loading || !sum) return null;                       // no data surface (e.g. /admin), or not loaded yet

  const hasFeeds = sum.feeds.length > 0;
  const manualOnly = !hasFeeds && sum.manual.length > 0;
  if (!hasFeeds && !manualOnly) return null;

  const color = TONE_COLOR[sum.tone] || 'var(--t3)';
  const stale = sum.tone === 'error' || sum.tone === 'never';

  // ALWAYS name the feed the stamp refers to. An unqualified "Data as of 2h ago" reads as "this
  // whole page is 2h old", so it looks wrong the moment you can see a fresher number on the page
  // (Afshaan, S220: chip said 2h — the weakest link — while Cred was visibly updating). The stamp
  // is bounded by ONE feed; say which, and the number stops contradicting the screen.
  // A fresh-but-erroring feed is NOT "behind" — say what's actually wrong, not a misleading age.
  const badLabel = (f) => !f.last_ok_at ? `${f.name} never run`
    : f.last_error ? `${f.name} erroring`
    : `${f.name} ${shortAge(f.last_ok_at, now)} behind`;

  const label = manualOnly
    ? `Updated ${ago(sum.manual[0]?.at, now)}`
    : stale && sum.worst
      ? badLabel(sum.worst)
      : sum.feeds.length === 1
        ? `${sum.feeds[0].name} · ${ago(sum.oldestAt, now)}`
        : `Oldest ${sum.worst?.name} · ${ago(sum.oldestAt, now)}`;

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Data freshness — click for the per-feed breakdown"
        style={{
          display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
          background: 'var(--surface2)', border: `1px solid ${stale ? color : 'var(--border)'}`,
          borderRadius: 999, padding: '5px 11px', fontFamily: 'var(--mono)', fontSize: 11,
          color: stale ? color : 'var(--t2)', whiteSpace: 'nowrap',
        }}>
        <span className="so-dot" style={{ background: color, flexShrink: 0 }} />
        {label}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 60, width: 320,
          background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 12,
          boxShadow: 'var(--card-shadow, 0 12px 34px rgba(0,0,0,.4))', padding: 14,
        }}>
          <div className="so-kpi-lbl" style={{ margin: '0 0 4px' }}>Data freshness</div>
          <div style={{ fontSize: 10.5, color: 'var(--t3)', lineHeight: 1.45, marginBottom: 11 }}>
            This page is only as fresh as its stalest feed. Feeds refresh hourly.
          </div>

          {sum.feeds.map(f => {
            const c = TONE_COLOR[f.status] || 'var(--t3)';
            return (
              <div key={f.channel_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)' }}>
                <span className="so-dot" style={{ background: c, flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: f.status === 'ok' ? 'var(--t3)' : c }}>{ago(f.last_ok_at, now)}</span>
              </div>
            );
          })}

          {sum.feeds.some(f => f.last_error) && (
            <div style={{ marginTop: 9, fontSize: 10.5, color: 'var(--red)', lineHeight: 1.45 }}>
              {sum.feeds.filter(f => f.last_error).map(f => f.name).join(', ')} reported an error on the last run.
            </div>
          )}

          {sum.manual.length > 0 && (
            <>
              <div className="so-kpi-lbl" style={{ margin: '13px 0 4px' }}>Manual inputs</div>
              <div style={{ fontSize: 10.5, color: 'var(--t3)', lineHeight: 1.45, marginBottom: 6 }}>
                Hand-entered — these go stale by neglect, not by breakage.
              </div>
              {sum.manual.map(m => (
                <div key={m.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)', flex: 1 }}>{m.label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t3)' }}>{m.at ? ago(m.at, now) : 'never'}</span>
                </div>
              ))}
            </>
          )}

          <a href="/connectors" style={{ display: 'block', marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>
            All connectors →
          </a>
        </div>
      )}
    </div>
  );
}
