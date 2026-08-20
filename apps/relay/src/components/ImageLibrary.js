'use client';
// Shared image library for Relay templates (S251).
//
// Before this, every image had to be uploaded from scratch inside the template that used
// it, one file at a time, with no way to see or reuse anything uploaded earlier — even
// though 28 images were already sitting in the bucket. Both authoring surfaces (the email
// editor's asset manager and the WhatsApp header) have always uploaded into the SAME
// bucket, `relay-email-assets`, so the library is not a new store: it is the first view
// onto the one that already existed.
//
// Two behaviours, deliberately in one component so they cannot drift apart:
//   · pick   — choose an already-uploaded image
//   · upload — drop or select MANY files at once (the old flow was strictly one-by-one)
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase, garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Upload, X, RefreshCw, Check, ImageOff } from 'lucide-react';
import { Btn } from '@/components/ui.js';

// Mirrors the bucket's own limits AND commsops/email-assets.js. The bucket is the real
// enforcement point (a signed upload URL is minted before the file exists, so the worker
// can only vet the CLAIMED type) — these exist to fail fast with a readable message
// instead of a storage-layer error the author cannot act on.
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ACCEPT_MIME = 'image/png,image/jpeg,image/gif,image/webp';
const BUCKET = 'relay-email-assets';

export async function uploadOne(file, session) {
  if (!file.type || !file.type.startsWith('image/')) throw new Error(`${file.name}: not an image`);
  if (file.size > MAX_ASSET_BYTES) throw new Error(`${file.name}: larger than 5MB`);
  const r = await workerFetch('createEmailAssetUploadUrl',
    { file_name: file.name, mime_type: file.type }, session);
  const d = r?.data;
  if (!d?.token || !d?.storage_path) throw new Error(r?.error || `${file.name}: sign failed`);
  const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(d.storage_path, d.token, file);
  if (up.error) throw up.error;
  return d.public_url;
}

// Upload many, and report per-file. A partial failure must NOT read as a total one:
// picking 8 images where the 5th is a 12MB PNG should land 7 and name the one that didn't.
export async function uploadMany(files, session, onProgress) {
  const urls = [];
  const failures = [];
  let done = 0;
  for (const f of files) {
    try { urls.push(await uploadOne(f, session)); }
    catch (e) { failures.push(e?.message || String(e)); }
    done += 1;
    if (onProgress) onProgress(done, files.length);
  }
  return { urls, failures };
}

function prettySize(n) {
  if (n == null) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/**
 * onPick(url)  — required. Called with the chosen public URL; the modal then closes.
 * onClose()    — required.
 * multi        — when true, "Use N selected" returns an ARRAY via onPickMany.
 */
export default function ImageLibrary({ session, onPick, onPickMany, onClose, multi = false }) {
  const { showToast } = useToast();
  const [assets, setAssets] = useState(null);      // null = not loaded yet, [] = genuinely empty
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [selected, setSelected] = useState([]);
  const [dragging, setDragging] = useState(false);
  // True from the moment we ask for the OS file picker until it resolves. The backdrop
  // closes this modal on any outside click, so coming back from the native dialog and
  // clicking onto the page dismissed the library — indistinguishable, to the operator,
  // from the upload button doing nothing. The Library PAGE has no backdrop, which is
  // exactly why uploading worked there and appeared not to here (Pruthvi, 2026-08-20).
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const r = await garageFetch('getMediaLibrary', { limit: 200 }, session);
      setAssets(Array.isArray(r?.assets) ? r.assets : []);
    } catch (e) {
      // An empty grid and a failed fetch look identical to the user and mean opposite
      // things — one says "upload your first image", the other "we could not read the
      // library". Never let a failure render as the empty state.
      setLoadError(true);
      setAssets([]);
      showToast(e.message || 'Could not load the image library', 'error');
    }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  // Belt and braces for pickerOpen. Not every browser fires `cancel` on a file input, and a
  // stuck `true` would mean the backdrop never closes the modal again. Regaining window focus
  // means the native dialog is gone either way; the delay lets a real `change` land first so
  // an actual upload still suppresses the backdrop while it runs.
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const clear = () => setTimeout(() => setPickerOpen(false), 300);
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, [pickerOpen]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy(true);
    setProgress([0, files.length]);
    try {
      const { urls, failures } = await uploadMany(files, session, (d, t) => setProgress([d, t]));
      if (urls.length) showToast(`Uploaded ${urls.length} image${urls.length === 1 ? '' : 's'}`, 'success');
      // Name what failed rather than a bare count — "too large" on an unnamed file in a
      // batch of eight is not actionable.
      if (failures.length) showToast(failures.join(' · '), 'error');
      await load();
      if (urls.length) setSelected((s) => (multi ? [...s, ...urls] : [urls[0]]));
    } finally { setBusy(false); setProgress(null); }
  }

  function toggle(url) {
    if (!multi) { onPick(url); onClose(); return; }
    setSelected((s) => (s.includes(url) ? s.filter((u) => u !== url) : [...s, url]));
  }

  return (
    <div onClick={() => { if (busy || pickerOpen) return; onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        style={{ width: 'min(920px, 96vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
          background: 'var(--surface, #14161a)', border: `1px solid ${dragging ? 'var(--accent, #7c9bff)' : 'var(--bd, #2a2e35)'}`,
          borderRadius: 12, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
          borderBottom: '1px solid var(--line, #24272d)' }}>
          <b style={{ fontSize: 14 }}>Image library</b>
          <span className="dim" style={{ fontSize: 12 }}>
            {assets == null ? '' : `${assets.length} image${assets.length === 1 ? '' : 's'} · drop files anywhere in this window`}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn onClick={load} disabled={busy}><RefreshCw size={14} /> Refresh</Btn>
            <Btn kind="primary" onClick={() => { if (!fileRef.current) return; setPickerOpen(true); fileRef.current.click(); }} disabled={busy}>
              <Upload size={14} /> {busy ? 'Uploading…' : 'Upload images'}
            </Btn>
            <Btn onClick={onClose}><X size={14} /></Btn>
          </span>
        </div>

        {progress && (
          <div className="tw-note" style={{ margin: 0, borderRadius: 0 }}>
            Uploading {progress[0]} of {progress[1]}…
          </div>
        )}

        <div style={{ padding: 14, overflowY: 'auto', flex: 1 }}>
          {assets == null ? (
            <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : loadError ? (
            <div style={{ padding: 30, textAlign: 'center' }}>
              <ImageOff size={22} style={{ opacity: .5 }} />
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--red, #f87171)' }}>
                Could not load the library.
              </div>
              <div style={{ marginTop: 10 }}><Btn onClick={load}><RefreshCw size={14} /> Retry</Btn></div>
            </div>
          ) : assets.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--t3, #9aa0aa)', fontSize: 13 }}>
              No images yet — upload one, or drop files here.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10,
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
              {assets.map((a) => {
                const on = selected.includes(a.url);
                return (
                  <button key={a.path} type="button" onClick={() => toggle(a.url)} title={a.name}
                    style={{ padding: 0, cursor: 'pointer', textAlign: 'left', background: 'transparent',
                      border: `2px solid ${on ? 'var(--accent, #7c9bff)' : 'var(--bd, #2a2e35)'}`,
                      borderRadius: 10, overflow: 'hidden', position: 'relative' }}>
                    {on && (
                      <span style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20,
                        borderRadius: 999, background: 'var(--accent, #7c9bff)', color: '#0b0d10',
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Check size={12} />
                      </span>
                    )}
                    {/* Checkerboard so a transparent PNG does not read as a blank tile. */}
                    <span style={{ display: 'block', height: 104, background:
                      'repeating-conic-gradient(#2a2e35 0% 25%, #22252b 0% 50%) 50%/16px 16px' }}>
                      <img src={a.url} alt={a.name} loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                    </span>
                    <span style={{ display: 'block', padding: '6px 8px', fontSize: 10.5, lineHeight: 1.35 }}>
                      <span className="mono" style={{ display: 'block', color: 'var(--t2, #c8ccd2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {/* Uploads are stored as `<epoch-ms>_<name>`; the prefix is plumbing. */}
                        {a.name.replace(/^\d+_/, '')}
                      </span>
                      <span className="dim">{prettySize(a.size)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {multi && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            borderTop: '1px solid var(--line, #24272d)' }}>
            <span className="dim" style={{ fontSize: 12 }}>{selected.length} selected</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn kind="primary" disabled={!selected.length}
                onClick={() => { onPickMany && onPickMany(selected); onClose(); }}>
                <Check size={14} /> Use {selected.length || ''}
              </Btn>
            </span>
          </div>
        )}

        {/* `cancel` fires when the native dialog is dismissed without choosing; without it
            pickerOpen would stay true and the backdrop would stop closing the modal at all. */}
        <input ref={fileRef} type="file" accept={ACCEPT_MIME} multiple style={{ display: 'none' }}
          onCancel={() => setPickerOpen(false)}
          onChange={(e) => { const f = e.target.files; e.target.value = ''; setPickerOpen(false); handleFiles(f); }} />
      </div>
    </div>
  );
}
