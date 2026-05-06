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
      height: 44, borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 20px',
      gap: 10, flexShrink: 0, background: '#0e0e0e',
    }}>
      <span style={{
        fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em',
        fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
      }}>
        {activeGroup?.label}
      </span>
      <span style={{ color: 'var(--border2)', fontSize: 14 }}>/</span>
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '.06em',
        color: 'var(--t1)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
      }}>
        {activeItem?.label?.toUpperCase() || ''}
      </span>

      {showSubTabs && (
        <div style={{
          display: 'flex', gap: 2,
          marginLeft: 20, borderLeft: '1px solid var(--border)', paddingLeft: 14,
        }}>
          {subTabs.map(item => {
            const isActive = pathname === item.route || pathname.startsWith(item.route + '/');
            return (
              <button
                key={item.id}
                onClick={() => onTabSelect && onTabSelect(item)}
                style={{
                  background: isActive ? 'rgba(242,205,26,.07)' : 'none',
                  border: 'none', borderRadius: 4, padding: '4px 10px',
                  fontSize: 10, color: isActive ? 'var(--yellow)' : 'var(--t3)',
                  cursor: 'pointer', fontFamily: 'var(--mono)',
                  display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                }}
              >
                {item.label}
                {item.badge || null}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {children}
        {refreshing && (
          <span style={{ fontSize: 9, color: 'var(--t3)', letterSpacing: '.1em' }}>↻ UPDATING</span>
        )}
        {lastRefreshed && !refreshing && (
          <span style={{ fontSize: 9, color: 'var(--t3)', letterSpacing: '.04em' }}>{lastRefreshed}</span>
        )}
        <span style={{
          fontSize: 9, color: 'var(--t3)', letterSpacing: '.04em',
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <span style={{
            width: 6, height: 6, background: 'var(--green)',
            borderRadius: '50%', display: 'inline-block',
          }} />
          LIVE
        </span>
      </div>
    </div>
  );
}
