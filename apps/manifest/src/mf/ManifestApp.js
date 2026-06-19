'use client';
// Manifest "Pit Wall" — single-page screen switcher shell, wired to manifestops.
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Sidebar, Topbar, Tweaks } from './Chrome.js';
import { Drawer } from './Drawer.js';
import { SCREENS } from './screens.js';
import { ACCENTS } from './nav.js';
import { useIsMobile } from './ui.js';

const DENSITY = {
  comfortable: { '--gap': '16px', '--cardpad': '18px 20px', '--rowpy': '11px' },
  compact:     { '--gap': '11px', '--cardpad': '14px 16px', '--rowpy': '7px' },
};
const ls = (k, fb) => {
  if (typeof window === 'undefined') return fb;
  try { const v = window.localStorage.getItem(k); return v == null ? fb : v; } catch { return fb; }
};

export default function ManifestApp() {
  const { session, signOut } = useAuth();
  const [screen, setScreen] = useState('dashboard');
  const [unauth, setUnauth] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false); // phone: off-canvas drawer open
  const [drill, setDrill] = useState(null);
  const [accent, setAccent] = useState('#F2CD1A');
  const [density, setDensity] = useState('comfortable');
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setScreen(ls('mf_screen', 'dashboard'));
    setCollapsed(ls('mf_sb', '0') === '1');
    setAccent(ACCENTS.includes(ls('mf_accent', '')) ? ls('mf_accent', '#F2CD1A') : '#F2CD1A');
    setDensity(ls('mf_density', 'comfortable') === 'compact' ? 'compact' : 'comfortable');
    setHydrated(true);
  }, []);

  const reload = useCallback(async () => {
    if (!session) return;
    try { setError(''); setUnauth(false); const d = await garageFetch('getBootstrap', {}, session); setData(d); }
    catch (e) {
      const msg = e?.message || 'Could not load data';
      if (/unauthor/i.test(msg) || /Worker 401/.test(msg)) { setUnauth(true); setData(null); }
      else setError(msg);
    }
  }, [session]);
  useEffect(() => { reload(); }, [reload]);

  const persist = (k, v) => { try { window.localStorage.setItem(k, v); } catch {} };
  const nav = (s, arg) => { setDrill(null); setNavOpen(false); if ((s === 'orderDetail' || s === 'shipmentDetail') && arg != null) setDetailId(arg); setScreen(s); persist('mf_screen', s); };
  const toggle = () => setCollapsed((c) => { persist('mf_sb', c ? '0' : '1'); return !c; });
  const chooseAccent = (c) => { setAccent(c); persist('mf_accent', c); };
  const chooseDensity = (d) => { setDensity(d); persist('mf_density', d); };

  const Screen = SCREENS[screen] || SCREENS.dashboard;
  const themeVars = { '--accent': accent, ...DENSITY[density] };
  const counts = data?.summary?.counts || {};
  const badges = {
    orders: counts.total || 0,
    shipments: (data?.shipments || []).length || 0,
    drawdowns: data?.summary?.openDrawCount || 0,
  };

  if (hydrated && unauth) {
    return (
      <div style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b0d10)', color: 'var(--t1, #e7e9ec)', fontFamily: 'var(--font-mono, monospace)', padding: 24 }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 10, color: 'var(--t1, #e7e9ec)' }}>No access to Manifest</div>
          <p style={{ color: 'var(--t3, #8b9099)', fontSize: 13, lineHeight: 1.6 }}>
            Your account isn’t authorized for Manifest. Ask a super admin to grant you access.
          </p>
          <div style={{ fontSize: 12, color: 'var(--t2, #aab)', margin: '14px 0' }}>{session?.user?.email}</div>
          <button onClick={signOut} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border, #2a2f37)', background: 'transparent', color: 'var(--t1, #e7e9ec)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', ...themeVars, visibility: hydrated ? 'visible' : 'hidden' }}>
      <Sidebar collapsed={collapsed} onToggle={toggle} screen={screen} onNav={nav} badges={badges} fx={data?.fx?.current} me={data?.me}
        isMobile={isMobile} mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <Topbar screen={screen} fx={data?.fx?.current} isMobile={isMobile} onMenu={() => setNavOpen(true)} />
        <main style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px 88px' : '24px 28px 60px' }}>
          {error ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--red)', padding: 24 }}>
              Failed to load Manifest data: {error}
            </div>
          ) : !data ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--t3)', padding: 24 }}>Loading…</div>
          ) : (
            <Screen data={data} onNav={nav} openDrill={setDrill} detailId={detailId} session={session} reload={reload} />
          )}
        </main>
      </div>
      {drill && <Drawer entry={drill} orders={data?.orders || []} onClose={() => setDrill(null)} onNav={nav} />}
      <Tweaks accent={accent} setAccent={chooseAccent} density={density} setDensity={chooseDensity} />
    </div>
  );
}
