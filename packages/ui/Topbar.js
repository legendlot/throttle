'use client';

// Self-injected style, same pattern as the shared Sidebar (.sb-wrap) — inline styles cannot
// carry a media query, and this rule has to be width-conditional.
//
// ⚠️ WHY THE SUB-TABS ARE HIDDEN ON A PHONE RATHER THAN MADE SCROLLABLE. Measured live on
// Ignition /engagements at 375px (2026-09-01, S327): the row is 699px of content and the
// header's other children (breadcrumb, page title, right cluster) leave it a clientWidth of
// **16px**. `overflowX:auto` alone therefore "worked" — technically scrollable — while being
// useless, a 16px porthole onto seven tabs. Every app that renders this Topbar also renders a
// bottom tab bar plus a "More" sheet carrying the FULL grouped nav under 767px, so hiding the
// row loses no destination; it removes a control that could not be operated anyway.
// The scroller is KEPT for widths where the row has real space but can still overflow.
const STYLE = `
.tb-subtabs { overflow-x: auto; min-width: 0; scrollbar-width: thin; }
@media (max-width: 767px) { .tb-subtabs { display: none !important; } }
`;

export function Topbar({
  navGroups = [],
  pathname = '',
  onTabSelect,
  refreshing,
  lastRefreshed,
  children,
}) {
  const activeGroup = navGroups.find(g =>
    (g.items || []).some(i => pathname === i.route || pathname.startsWith(i.route + '/'))
  ) || navGroups[0];

  const subTabs = (activeGroup?.items || []).filter(i => !i.separator);
  const activeItem = subTabs.find(i =>
    pathname === i.route || pathname.startsWith(i.route + '/')
  ) || subTabs[0];

  const showSubTabs = subTabs.length > 1;

  return (
    <div style={{
      height: 56,
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center',
      padding: '0 24px', gap: 12,
      flexShrink: 0,
      background: 'var(--bg, transparent)',
    }}>
      <style>{STYLE}</style>
      {/* Breadcrumb — group label */}
      <span style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--t2)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {activeGroup?.label}
      </span>

      <span style={{ color: 'var(--border2)', fontSize: 16 }}>/</span>

      {/* Current page title — semantic h1, Tomorrow, big and confident */}
      <h1 style={{
        margin: 0,
        fontFamily: 'var(--cond)',
        fontSize: 16,
        fontWeight: 700,
        letterSpacing: '0.06em',
        color: 'var(--t1)',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {activeItem?.label || ''}
      </h1>

      {showSubTabs && (
        <div className="tb-subtabs" style={{
          display: 'flex', gap: 4,
          marginLeft: 20,
          borderLeft: '1px solid var(--border)',
          paddingLeft: 16,
          // S304 rule at the source (2026-09-01, S327). Every tab button is whiteSpace:nowrap
          // and this row never wrapped, while the app shells wrap the Topbar in
          // `overflow:hidden` — so tabs past the right edge were clipped with no scroller.
          // The scroll + hide-on-phone rules live in STYLE above (a media query cannot be an
          // inline style); read the comment there before changing either.
        }}>
          {subTabs.map(item => {
            const isActive = pathname === item.route || pathname.startsWith(item.route + '/');
            return (
              <button
                key={item.id}
                onClick={() => onTabSelect && onTabSelect(item)}
                style={{
                  background: isActive ? 'rgba(242, 205, 26, 0.08)' : 'none',
                  border: 'none',
                  borderRadius: 4,
                  padding: '6px 12px',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--yellow)' : 'var(--t2)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  whiteSpace: 'nowrap',
                  transition: 'color 120ms, background 120ms',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.color = 'var(--t1)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.color = 'var(--t2)';
                }}
              >
                {item.label}
                {item.badge || null}
              </button>
            );
          })}
        </div>
      )}

      <div style={{
        marginLeft: 'auto',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        {children}
        {refreshing && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--t2)', letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>↻ Updating</span>
        )}
        {lastRefreshed && !refreshing && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--t3)', letterSpacing: '0.04em',
          }}>{lastRefreshed}</span>
        )}
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--t2)', letterSpacing: '0.08em',
          textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 7, height: 7,
            background: 'var(--green)',
            borderRadius: '50%',
            display: 'inline-block',
          }} />
          Live
        </span>
      </div>
    </div>
  );
}
