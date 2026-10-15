'use client';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { useLoad } from './ui.js';
import Pack from './Pack.js';
import Cartons from './Cartons.js';
import Consignments from './Consignments.js';
import Mint from './Mint.js';
import Printing from './Printing.js';
import Board from './Board.js';

// The worker's floor session idles out after 60 min, but this screen polls (print status, board), which keeps it alive.
// So the bench enforces the idle rule itself: 60 min with no key or pointer input → log out.
const IDLE_MS = 60 * 60_000;

const TABS = [
  { id: 'pack', label: 'Pair & Pack', C: Pack },
  { id: 'cartons', label: 'Cartons', C: Cartons },
  { id: 'consignments', label: 'Consignments', C: Consignments, sup: true },
  { id: 'mint', label: 'Stickers', C: Mint, sup: true },
  { id: 'printing', label: 'Printing', C: Printing },
  { id: 'board', label: 'Floor board', C: Board, sup: true },
];

export default function Floor({ me, onLogout }) {
  const { showToast } = useToast();
  const sup = me.operator.role === 'supervisor';
  const tabs = TABS.filter(t => !t.sup || sup);
  const [tab, setTab] = useState('pack');
  const status = useLoad('/v/print_status', { every: 30_000 });
  const c = status.data?.counts || {};
  const attention = Number(c.outcome_unknown || 0) + Number(c.failed || 0) + Number(c.late_print || 0);
  const anyOffline = (status.data?.agents || []).some(a => !a.online);
  const Cur = (tabs.find(t => t.id === tab) || tabs[0]).C;
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const touch = () => { lastInput.current = Date.now(); };
    window.addEventListener('keydown', touch, true);
    window.addEventListener('pointerdown', touch, true);
    const t = setInterval(() => { if (Date.now() - lastInput.current > IDLE_MS) onLogout(); }, 60_000);
    return () => { window.removeEventListener('keydown', touch, true); window.removeEventListener('pointerdown', touch, true); clearInterval(t); };
  }, [onLogout]);
  return (
    <div>
      <header className="top">
        <span className="brand">OUTPOST</span>
        <span className="muted">{me.vendor_name}</span>
        <span className="badge">Bench {me.device.bench_no ?? '—'}</span>
        <div className="who">
          <span>{me.operator.name} <span className="dim">· {me.operator.op_code} · {me.operator.role}</span></span>
          <button className="btn sm" onClick={async () => { const m = await onLogout(); if (m) showToast(`Not logged out: ${m}`, 'error', 6000); }}>Log out</button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'printing' && (attention > 0 || anyOffline) && <span className="pip">{attention || '!'}</span>}
          </button>
        ))}
      </nav>
      <main className="main">
        <Cur me={me} sup={sup} printStatus={status} goto={setTab} />
      </main>
    </div>
  );
}
