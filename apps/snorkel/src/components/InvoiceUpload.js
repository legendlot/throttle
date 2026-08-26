'use client';
import { useRef, useState, useCallback } from 'react';
import { Btn } from '@/components/ui.js';

// Invoice capture. Two equally-weighted entry points — "Take photo" opens the rear camera
// directly, "Upload file" is gallery/Files/desktop. Capture is not a fallback: in #payments the
// overwhelming majority of invoices arrive as phone photos of paper.
//
// ⚠️ S305 (throttle 543b03e6): four file pickers in this monorepo silently discarded every file
// the user chose. Each held `e.target.files` and then set `e.target.value = ''` BEFORE consuming
// it — `input.files` returns the SAME live FileList object on every access, so clearing `value`
// empties the reference already held, and consumers hit `if (!files.length) return` with no error,
// no toast and no console output. It cost Garage gate-pass every attachment for two days.
// The rule below is the fix: lift the File objects out with Array.from FIRST, then clear.
// Never pair a functional state updater with an eager clear — React defers the updater to the
// render phase and the clear always wins.

const MAX_EDGE = 2000;   // long edge after downscale
const JPEG_Q   = 0.8;
const MAX_BYTES = 25 * 1024 * 1024;

// A raw rear-camera capture is typically 3–8 MB against the 130–370 KB WhatsApp images seen in
// #payments. Un-downscaled, the first request raised on the factory connection stalls and the
// requester goes back to Slack. Aspect ratio is preserved; never crop an invoice.
async function downscaleImage(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    if (scale === 1 && file.size < 1_500_000) { bitmap.close?.(); return file; }
    const w = Math.round(width * scale), h = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_Q));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(heic|png|webp)$/i, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file; // a downscale failure must never lose the invoice
  }
}

export default function InvoiceUpload({ files, onChange, disabled }) {
  const cameraRef = useRef(null);
  const fileRef   = useRef(null);
  const [working, setWorking] = useState(false);

  const accept = useCallback(async (e) => {
    // ── the S305 rule: lift the Files out BEFORE the input is touched ──
    const picked = Array.from(e.target.files || []);
    e.target.value = '';                       // safe now — `picked` holds real File objects
    if (!picked.length) return;

    setWorking(true);
    try {
      const out = [];
      for (const f of picked) {
        const processed = await downscaleImage(f);
        if (processed.size > MAX_BYTES) {
          out.push({ file: processed, error: 'Too large (max 25 MB)' });
        } else {
          out.push({
            file: processed,
            preview: processed.type.startsWith('image/') ? URL.createObjectURL(processed) : null,
          });
        }
      }
      onChange([...files, ...out]);
    } finally { setWorking(false); }
  }, [files, onChange]);

  function remove(i) {
    const next = files.slice();
    if (next[i]?.preview) URL.revokeObjectURL(next[i].preview);
    next.splice(i, 1);
    onChange(next);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn kind="primary" type="button" onClick={() => cameraRef.current?.click()} disabled={disabled || working}>
          📷 Take photo
        </Btn>
        <Btn type="button" kind="ghost" onClick={() => fileRef.current?.click()} disabled={disabled || working}>
          Upload file
        </Btn>
        {working && <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--t2)' }}>Processing…</span>}
      </div>

      {/* capture="environment" opens the rear camera on Android/iOS. It is SILENTLY IGNORED on
          desktop, which is why this needs a real-device smoke — on a laptop it degrades to a
          normal file dialog and will look like it works while proving nothing. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment"
             onChange={accept} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" multiple accept="image/*,application/pdf"
             onChange={accept} style={{ display: 'none' }} />

      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          {files.map((f, i) => (
            <div key={i} style={{
              width: 104, border: '1px solid var(--bd)', borderRadius: 8, padding: 6,
              background: 'var(--surface)', position: 'relative',
            }}>
              {f.preview
                ? <img src={f.preview} alt="" style={{ width: '100%', height: 68, objectFit: 'cover', borderRadius: 4 }} />
                : <div style={{
                    height: 68, display: 'grid', placeItems: 'center',
                    background: 'var(--surface-2, #0002)', borderRadius: 4, fontSize: 22,
                  }}>📄</div>}
              <div style={{
                fontSize: 10, marginTop: 4, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--t2)',
              }} title={f.file.name}>{f.file.name}</div>
              {f.error && <div style={{ fontSize: 10, color: 'var(--red-fg)' }}>{f.error}</div>}
              <button type="button" onClick={() => remove(i)} aria-label="Remove"
                style={{
                  position: 'absolute', top: -8, right: -8, width: 22, height: 22,
                  borderRadius: '50%', border: '1px solid var(--bd)', background: 'var(--surface)',
                  cursor: 'pointer', lineHeight: '18px', fontSize: 13, color: 'var(--t1)',
                }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 8 }}>
        Attach the invoice — a photo is fine. Multiple files allowed.
      </div>
    </div>
  );
}
