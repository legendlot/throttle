'use client';
// The viewfinder around camera.mjs. React only starts and stops the engine; the scan loop runs outside it, so nothing on
// this screen re-renders per frame. Codes reach the screen through `onCodes(values, at)`; return false to leave them
// unread (the engine reads them again on the next frame) — the screen does that while it is busy.
// Shared from @throttle/ui (moved from apps/outpost/src/op/Camera.js) so any app can scan with the phone camera; it
// carries its own viewfinder CSS (injected once), with colour fallbacks for a host app without Outpost's variables.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { overlayRect, startCamera } from './camera.mjs';

const TORCH_KEY = 'outpost.torch';

// The viewfinder rules (Outpost globals.css "camera viewfinder"): the picture fills the box; the frame marks exactly
// the part the engine reads.
const CSS_ID = 'throttle-camera-css';
const CSS = `
.cam { position: relative; width: 100%; aspect-ratio: 4 / 3; max-height: 46vh; background: #000; border-radius: 12px; overflow: hidden; }
.cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cam .aim { position: absolute; left: 20%; top: 20%; width: 60%; height: 60%; border: 3px solid rgba(242, 205, 26, .85); border-radius: 10px; box-shadow: 0 0 0 100vmax rgba(0, 0, 0, .28); pointer-events: none; transition: border-color .1s; }
.cam .aim.ok { border-color: var(--green, #34d27b); background: rgba(52, 210, 123, .22); }
.cam .aim.bad { border-color: var(--red, #ff6b6b); background: rgba(255, 107, 107, .25); }
.cam .camnote { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; text-align: center; color: #fff; background: rgba(0, 0, 0, .65); font-weight: 600; cursor: pointer; }
.cam .camtop { position: absolute; left: 0; right: 0; top: 0; padding: 8px 10px; background: linear-gradient(rgba(0, 0, 0, .65), transparent); color: #fff; font-weight: 800; }
.cam .torch { position: absolute; right: 10px; bottom: 10px; background: rgba(0, 0, 0, .55); color: #fff; }
.cam .torch.on { background: var(--accent, #f2cd1a); color: var(--accent-fg, #111); border-color: var(--accent, #f2cd1a); }
.camstats { font-size: 12px; margin-top: 6px; font-family: var(--mono, ui-monospace, monospace); }
`;
let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement('style');
  s.id = CSS_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CameraView = forwardRef(function CameraView({ on = true, formats, onCodes, onReady, showStats = false, children }, ref) {
  const box = useRef(null);
  const video = useRef(null);
  const frame = useRef(null);
  const cam = useRef(null);
  const handler = useRef(onCodes);
  handler.current = onCodes;
  const ready = useRef(onReady);
  ready.current = onReady;
  const [state, setState] = useState({ phase: 'off', error: null, info: null });
  const [torch, setTorch] = useState(false);
  const [stats, setStats] = useState(null);
  const [run, setRun] = useState(0);              // bump = restart (retry, back from another app)
  const [visible, setVisible] = useState(true);
  const fmtKey = (formats || []).join(',');      // a new array with the same formats must not restart the camera

  useEffect(() => { injectCss(); }, []);
  useEffect(() => { try { setTorch(localStorage.getItem(TORCH_KEY) === '1'); } catch { /* none */ } }, []);
  useEffect(() => {
    const v = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, []);

  // Green / red flash on the aiming frame, straight on the DOM (no re-render).
  useImperativeHandle(ref, () => ({
    flash(ok) {
      const f = frame.current;
      if (!f) return;
      f.classList.remove('ok', 'bad'); void f.offsetWidth; f.classList.add(ok ? 'ok' : 'bad');
      clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove('ok', 'bad'), 450);
    },
    stats: () => cam.current?.stats() || null,
  }), []);

  // Place the aiming frame over the part of the picture the engine reads.
  const place = () => {
    const v = video.current, b = box.current, f = frame.current;
    if (!v || !b || !f) return;
    const r = overlayRect(v.videoWidth, v.videoHeight, b.clientWidth, b.clientHeight);
    if (!r) return;
    Object.assign(f.style, { left: `${r.left * 100}%`, top: `${r.top * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` });
  };

  useEffect(() => {
    if (!on || !visible || !video.current) return undefined;
    setState({ phase: 'starting', error: null, info: null });
    let torchOn = false;
    try { torchOn = localStorage.getItem(TORCH_KEY) === '1'; } catch { /* none */ }
    const c = startCamera(video.current, {
      formats, torch: torchOn,
      box: () => (box.current ? { w: box.current.clientWidth, h: box.current.clientHeight } : null),
      onCodes: (values, at) => handler.current?.(values, at),
      onReady: info => { setState({ phase: 'live', error: null, info }); place(); ready.current?.(info); },
      onError: e => setState({ phase: 'error', error: e?.name === 'NotAllowedError'
        ? 'Camera permission is off. Allow the camera for this site (the lock icon in the address bar), then tap to retry.'
        : `Camera did not start: ${e?.message || e}`, info: null }),
    });
    cam.current = c;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(box.current);
    return () => { ro?.disconnect(); c.stop(); cam.current = null; setState(s => ({ ...s, phase: 'off' })); };
  }, [on, visible, run, fmtKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showStats || state.phase !== 'live') return undefined;
    const t = setInterval(() => setStats(cam.current?.stats() || null), 1000);
    return () => clearInterval(t);
  }, [showStats, state.phase]);

  const flipTorch = () => {
    const v = !torch;
    setTorch(v);
    try { localStorage.setItem(TORCH_KEY, v ? '1' : '0'); } catch { /* none */ }
    cam.current?.setTorch(v);
  };

  return (
    <div>
      <div ref={box} className="cam" onClick={state.phase === 'error' ? () => setRun(n => n + 1) : undefined}>
        <video ref={video} playsInline muted autoPlay />
        <div ref={frame} className="aim" />
        {children && <div className="camtop">{children}</div>}
        {state.phase !== 'live' && (
          <div className="camnote">
            {!on ? 'Camera paused' : state.phase === 'error' ? state.error : 'Starting camera…'}
          </div>
        )}
        {state.phase === 'live' && state.info?.torch && (
          <button type="button" className={`btn sm torch ${torch ? 'on' : ''}`} onClick={flipTorch}>{torch ? 'Light on' : 'Light'}</button>
        )}
      </div>
      {showStats && state.info && (
        <div className="dim camstats">
          Camera ready in {Math.round(state.info.readyMs)} ms · {state.info.engine === 'native' ? 'phone decoder' : state.info.engine}
          {' '}· {state.info.width}×{state.info.height}
          {stats?.fps ? ` · ${Math.round(stats.fps)} reads/s` : ''}
          {stats?.detectMedian != null ? ` · read ${Math.round(stats.detectMedian)} ms (p95 ${Math.round(stats.detectP95)})` : ''}
        </div>
      )}
    </div>
  );
});

export default CameraView;
