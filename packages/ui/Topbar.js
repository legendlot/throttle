'use client';

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

      {/* Current page title — Tomorrow, big and confident */}
      <span style={{
        fontFamily: 'var(--cond)',
        fontSize: 16,
        fontWeight: 700,
        letterSpacing: '0.06em',
        color: 'var(--t1)',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {activeItem?.label || ''}
      </span>

      {showSubTabs && (
        <div style={{
          display: 'flex', gap: 4,
          marginLeft: 20,
          borderLeft: '1px solid var(--border)',
          paddingLeft: 16,
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
