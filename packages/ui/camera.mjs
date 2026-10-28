// Phone-camera scanning. This is the factory Scanner's camera engine (02_scanner/index.html startMainCamera + scanFrame,
// the Session 71 "enhanced" path), ported unchanged so a LOT phone reads stickers in Outpost the way it does on the
// floor: 1920×1080 ideal + continuous autofocus, the phone's native BarcodeDetector (ZXing 0.23.0, the Scanner's pinned
// version, only where the phone has none), the centre 60% of the frame, one detect in flight, a requestAnimationFrame
// loop that never touches React (the screen only changes when a code lands). `localStorage.scannerLegacy = '1'` is the
// Scanner's kill switch: 1280×720, full frame, ZXing.
// Four deliberate differences, each because a pair & pack bench is not a one-code station:
//   · the read area is the centre 60% CLIPPED to what the viewfinder shows (the Scanner reads off-screen rows on a
//     portrait phone; here a sticker just outside the picture, the next unit's, is never read);
//   · formats are per screen (Pair & Pack reads QR only: the LOT sticker; the EAN on the box is never mistaken for it);
//   · every code in the frame is passed on, not just the first (a car sticker left in view cannot hide the remote's);
//   · a code is passed on again only after it has left the view for REPEAT_GAP_MS (the Scanner re-reads a code still
//     under the lens every 2 s; here that would pair a car with itself or start the next unit with the last remote).
// ZXing is bundled (not from a CDN: a vendor-site network may not reach one, and the isolation gate checks every file)
// and loaded only on a device without BarcodeDetector, so a phone never downloads it.

export const REPEAT_GAP_MS = 1500;
export const ROI = 0.6;

// The centre ROI×ROI of a vw×vh frame — the same integer maths as the Scanner.
export function roiRect(vw, vh, roi = ROI) {
  const w = Math.floor(vw * roi), h = Math.floor(vh * roi);
  return { x: Math.floor((vw - w) / 2), y: Math.floor((vh - h) / 2), w, h };
}

// The part of a vw×vh frame the engine reads when it is shown object-fit: cover in a bw×bh box: the centre ROI,
// clipped to the part of the frame the box shows. No box size known → the plain ROI (the Scanner's).
export function readRect(vw, vh, bw, bh, roi = ROI) {
  const r = roiRect(vw, vh, roi);
  if (!bw || !bh) return r;
  const s = Math.max(bw / vw, bh / vh);
  const sw = Math.min(vw, Math.floor(bw / s)), sh = Math.min(vh, Math.floor(bh / s));   // the shown part, centred
  const sx = Math.floor((vw - sw) / 2), sy = Math.floor((vh - sh) / 2);
  const x = Math.max(r.x, sx), y = Math.max(r.y, sy);
  return { x, y, w: Math.min(r.x + r.w, sx + sw) - x, h: Math.min(r.y + r.h, sy + sh) - y };
}

// Where readRect sits on screen, as fractions of the box: the aiming frame drawn over the viewfinder.
export function overlayRect(vw, vh, bw, bh, roi = ROI) {
  if (!vw || !vh || !bw || !bh) return null;
  const s = Math.max(bw / vw, bh / vh);
  const ox = (bw - vw * s) / 2, oy = (bh - vh * s) / 2;
  const r = readRect(vw, vh, bw, bh, roi);
  return { left: (ox + r.x * s) / bw, top: (oy + r.y * s) / bh, width: (r.w * s) / bw, height: (r.h * s) / bh };
}

// Repeat gate: `see(codes, now)` returns the codes to act on. A code is new if it has not been seen for REPEAT_GAP_MS;
// every sighting (acted on or not) refreshes it, so a sticker sitting in view stays quiet however long it sits there.
export function makeRepeatGate(gap = REPEAT_GAP_MS) {
  const seen = new Map();
  return {
    see(codes, now) {
      const fresh = [];
      for (const c of codes) {
        const last = seen.get(c);
        if (last === undefined || now - last >= gap) fresh.push(c);
        seen.set(c, now);
      }
      if (seen.size > 64) for (const [c, t] of seen) if (now - t > gap * 4) seen.delete(c);
      return fresh;
    },
    forget(codes) { for (const c of codes) seen.delete(c); },     // not taken: read them again on the next frame
  };
}

const ZX_FORMAT = { qr_code: 'QR_CODE', ean_13: 'EAN_13', code_128: 'CODE_128', code_39: 'CODE_39', data_matrix: 'DATA_MATRIX' };
export const ALL_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'];   // the Scanner's list

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

// Open the camera into `video` and scan until stop(). `box()` returns the viewfinder's {w, h} in CSS px (read each
// frame, so a resize or a rotation is followed). onCodes(values, at) gets the new codes of a frame (at =
// performance.now() when the detect returned) and returns false to leave them unread for now. onReady(info) fires on the first frame; onError(err) if the camera
// cannot open. Returns { stop, stats, setTorch }.
export function startCamera(video, { formats = ALL_FORMATS, facing = 'environment', torch = false, box, onCodes, onReady, onError } = {}) {
  let legacy = false;
  try { legacy = localStorage.getItem('scannerLegacy') === '1'; } catch { /* no storage: enhanced */ }
  const t0 = performance.now();
  const gate = makeRepeatGate();
  const detectMs = [];                      // last 120 detect durations
  let frames = 0, fpsFrom = t0, fps = null;
  let stopped = false, stream = null, track = null, raf = 0, busy = false, engine = null, readyMs = null, wake = null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const constraints = legacy
    ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] };

  const lockScreen = async () => {
    try {
      if (stopped || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      const w = await navigator.wakeLock.request('screen');
      if (stopped) w.release(); else wake = w;          // stopped while the request was pending: give it back
    } catch { /* not allowed: the screen may sleep */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') lockScreen(); };   // the browser drops the lock on hide

  const emit = (values, at) => {
    const fresh = gate.see(values, at);
    if (fresh.length && !stopped && onCodes?.(fresh, at) === false) gate.forget(fresh);
  };

  async function makeDecoder() {
    if (!legacy && typeof window.BarcodeDetector !== 'undefined') {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats?.().catch(() => null);
        const want = supported ? formats.filter(f => supported.includes(f)) : formats;
        // A phone whose detector module is not installed yet reports no formats and would detect nothing, forever.
        if (want.length) {
          const d = new window.BarcodeDetector({ formats: want });
          engine = 'native';
          return async () => (await d.detect(canvas)).map(c => c.rawValue).filter(Boolean);
        }
      } catch { /* fall through to ZXing, as the Scanner does */ }
    }
    const ZX = await import('@zxing/library');
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, formats.map(f => ZX.BarcodeFormat[ZX_FORMAT[f]]).filter(v => v !== undefined));
    const reader = new ZX.BrowserMultiFormatReader(hints);
    engine = legacy ? 'zxing-legacy' : 'zxing';
    return async () => {
      try {
        const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(canvas)));
        const r = reader.decodeBitmap(bmp);
        return r ? [r.getText()] : [];
      } catch { return []; }                 // NotFound on most frames
    };
  }

  function loop(decode) {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && !busy) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        if (!legacy) {
          const b = box?.();
          const r = readRect(vw, vh, b?.w, b?.h);
          if (canvas.width !== r.w) canvas.width = r.w;
          if (canvas.height !== r.h) canvas.height = r.h;
          ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        } else {
          if (canvas.width !== vw) canvas.width = vw;
          if (canvas.height !== vh) canvas.height = vh;
          ctx.drawImage(video, 0, 0, vw, vh);
        }
        busy = true;
        const s = performance.now();
        decode().then(values => {
          const at = performance.now();
          busy = false;
          detectMs.push(at - s); if (detectMs.length > 120) detectMs.shift();
          frames++;
          if (at - fpsFrom >= 2000) { fps = (frames * 1000) / (at - fpsFrom); frames = 0; fpsFrom = at; }
          if (values.length) emit(values, at);
        }, () => { busy = false; });
      }
    }
    raf = requestAnimationFrame(() => loop(decode));
  }

  (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera (open Outpost in Chrome over https).');
      const decoding = makeDecoder();
      decoding.catch(() => {});                            // awaited below; a rejection must not go unhandled meanwhile
      stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      track = stream.getVideoTracks()[0];
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      const decode = await decoding;                       // ZXing chunk may fail to load: the catch stops the stream
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      const s = stream;
      video.setAttribute('playsinline', ''); video.muted = true;
      video.srcObject = s;
      video.addEventListener('playing', () => {
        if (readyMs !== null) return;
        readyMs = performance.now() - t0;
        onReady?.({ readyMs, engine, width: video.videoWidth, height: video.videoHeight, torch: !!track?.getCapabilities?.().torch });
      });
      await video.play().catch(() => {});
      if (stopped) return;                                 // stop() already released the stream
      if (torch) setTimeout(() => track?.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {}), 1000);   // as the Scanner: after 1 s
      lockScreen();
      document.addEventListener('visibilitychange', onVis);
      loop(decode);
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop());          // never leave the camera held after a failed start
      if (!stopped) onError?.(e);
    }
  })();

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      try { wake?.release(); } catch { /* gone */ }
      stream?.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    },
    setTorch(on) { return track?.applyConstraints({ advanced: [{ torch: !!on }] }).catch(() => {}); },
    stats() {
      return { engine, readyMs, width: video.videoWidth || null, height: video.videoHeight || null,
        fps, detectMedian: median(detectMs), detectP95: p95(detectMs), legacy };
    },
  };
}
