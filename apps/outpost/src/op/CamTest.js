'use client';
// outpost.legendoftoys.com/camtest/ — the camera benchmark. No enrolment, no login, no calls to LOT: it opens the same
// camera engine Pair & Pack uses and measures it on this phone, with real stickers, next to the factory Scanner.
//   page ready   = navigation start → the page can run (what a cold open costs before the camera is asked for)
//   camera ready = navigation start → first camera frame
//   read → beep  = the engine returning a code → the beep starting (the app's own overhead per scan)
//   gap          = time between two consecutive new stickers (the operator's real pace)
import { useEffect, useRef, useState } from 'react';
import CameraView from './Camera.js';
import { ALL_FORMATS } from './camera.mjs';
import { beep } from './ui.js';

const MODES = { outpost: { label: 'Pair & Pack (QR only)', formats: ['qr_code'] }, factory: { label: 'Factory Scanner formats (all 5)', formats: ALL_FORMATS } };
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const ms = v => (v == null ? '—' : `${Math.round(v)} ms`);

export default function CamTest() {
  const cam = useRef(null);
  const last = useRef(null);
  const [mode, setMode] = useState('outpost');
  const [nav, setNav] = useState(null);
  const [ready, setReady] = useState(null);
  const [scans, setScans] = useState([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const read = () => {
      const n = performance.getEntriesByType('navigation')[0];
      if (n) setNav({ interactive: n.domInteractive, loaded: n.loadEventEnd || null, transfer: n.transferSize, cached: n.transferSize === 0 });
    };
    if (document.readyState === 'complete') read(); else window.addEventListener('load', () => setTimeout(read, 0), { once: true });
  }, []);

  const onCodes = (values, at) => {
    beep(true);
    const beepMs = performance.now() - at;
    cam.current?.flash(true);
    const gap = last.current ? at - last.current : null;
    last.current = at;
    setScans(s => [{ n: s.length + 1, code: values.join(' + '), beepMs, gap, t: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) }, ...s].slice(0, 500));
    return true;
  };

  const gaps = scans.map(s => s.gap).filter(v => v != null);
  const beeps = scans.map(s => s.beepMs);
  const stats = cam.current?.stats?.();
  const report = () => [
    `Outpost camera test · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    `Device: ${navigator.userAgent}`,
    `Mode: ${MODES[mode].label}`,
    `Page ready: ${ms(nav?.interactive)} (${nav?.cached ? 'from cache' : `${Math.round((nav?.transfer || 0) / 1024)} KB downloaded`})`,
    `Camera ready: ${ms(ready?.sinceOpen)} after opening the page; ${ms(ready?.readyMs)} after asking for it`,
    `Engine: ${ready?.engine} · ${ready?.width}×${ready?.height} · ${stats?.fps ? Math.round(stats.fps) : '—'} reads/s · read ${ms(stats?.detectMedian)} (p95 ${ms(stats?.detectP95)})`,
    `Scans: ${scans.length} · read → beep median ${ms(med(beeps))} · gap median ${ms(med(gaps))}`,
    ...[...scans].reverse().map(s => `${s.n}\t${s.t}\t${s.code}\tbeep ${Math.round(s.beepMs)}\tgap ${s.gap == null ? '' : Math.round(s.gap)}`),
  ].join('\n');

  return (
    <div className="main" style={{ maxWidth: 640 }}>
      <div className="brand">OUTPOST · CAMERA TEST</div>
      <p className="muted" style={{ margin: '6px 0 12px', fontSize: 14 }}>
        Scan LOT stickers one after another. Nothing is sent to LOT. Same phone, same stickers: compare with the factory Scanner.
      </p>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          {Object.entries(MODES).map(([k, m]) => (
            <button key={k} className={`btn sm ${mode === k ? 'primary' : ''}`} onClick={() => { setMode(k); setReady(null); }}>{m.label}</button>
          ))}
        </div>
        <CameraView ref={cam} formats={MODES[mode].formats} onCodes={onCodes} showStats
          onReady={info => setReady({ ...info, sinceOpen: performance.now() })} />
        <div className="grid4" style={{ marginTop: 12, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <div className="kpi"><div className="n" style={{ fontSize: 20 }}>{ms(nav?.interactive)}</div><div className="l">page ready{nav?.cached ? ' (cached)' : ''}</div></div>
          <div className="kpi"><div className="n" style={{ fontSize: 20 }}>{ms(ready?.sinceOpen)}</div><div className="l">camera ready</div></div>
          <div className="kpi"><div className="n" style={{ fontSize: 20 }}>{ms(med(beeps))}</div><div className="l">read → beep (median)</div></div>
          <div className="kpi"><div className="n" style={{ fontSize: 20 }}>{scans.length}</div><div className="l">stickers read{gaps.length ? ` · ${ms(med(gaps))} apart` : ''}</div></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={async () => { try { await navigator.clipboard.writeText(report()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ } }}>{copied ? 'Copied' : 'Copy results'}</button>
          <button className="btn sm" onClick={() => { setScans([]); last.current = null; }}>Clear</button>
        </div>
      </div>
      <div className="card">
        <h3>Stickers read</h3>
        {!scans.length ? <div className="dim">None yet.</div> : (
          <table className="t" style={{ fontSize: 13 }}><tbody>
            {scans.map(s => <tr key={s.n}><td className="dim">{s.n}</td><td className="mono">{s.code}</td><td className="n">{s.gap == null ? '' : ms(s.gap)}</td></tr>)}
          </tbody></table>
        )}
      </div>
    </div>
  );
}
