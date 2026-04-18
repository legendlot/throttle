'use client';
import { Spinner } from './Spinner.js';

export function TopNav({ groups = [], activeTab, onTabSelect, rightSlot, onLogout, refreshing, lastRefreshed }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '8px 16px', borderBottom: '1px solid #222',
      background: '#0a0a0a', color: '#ccc',
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 13,
    }}>
      <nav style={{ display: 'flex', gap: 14, flex: 1 }}>
        {groups.map((g) => (
          <div key={g.id || g.label} style={{ position: 'relative' }}>
            <span style={{ color: '#777', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{g.label}</span>
            <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
              {(g.items || []).map((item) => {
                const active = activeTab === item.id || activeTab === item.route;
                return (
                  <button
                    key={item.id || item.route}
                    onClick={() => onTabSelect && onTabSelect(item)}
                    style={{
                      background: active ? '#222' : 'transparent',
                      border: '1px solid ' + (active ? '#444' : 'transparent'),
                      color: active ? '#fff' : '#aaa',
                      padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                      fontSize: 12, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center',
                    }}
                  >
                    {item.label}
                    {item.badge || null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      {refreshing && <Spinner size="sm" />}
      {lastRefreshed && <span style={{ fontSize: 11, color: '#666' }}>{lastRefreshed}</span>}
      {rightSlot}
      {onLogout && (
        <button onClick={onLogout} style={{ background: '#222', border: '1px solid #444', color: '#ccc', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
          Sign out
        </button>
      )}
    </header>
  );
}
