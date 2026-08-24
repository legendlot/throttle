'use client';
// Library — the standalone image surface (S251b).
//
// The library shipped first as a modal INSIDE the template editor, which meant the only
// way to load images was to open some template you might not even want to edit. Bulk
// upload — the actual job — had nowhere to happen. This is that place: drop a batch of
// images in before you start authoring, then pick them from any template.
//
// Same bucket, same worker actions as the picker modal. Nothing here is a second store.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Upload, RefreshCw, Trash2, Link2, ImageOff, Search, Download, Pencil, Check, X } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';
import { uploadMany, ACCEPT_MIME } from '@/components/ImageLibrary.js';
import { useConfirm } from '@/components/confirm.js';

function prettySize(n) {
  if (n == null) return '—';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
const cleanName = (n) => String(n || '').replace(/^\d+_/, '');

export default function LibraryPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [assets, setAssets] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState('');
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [renaming, setRenaming] = useState(null);   // path of the tile being renamed
  const [renameVal, setRenameVal] = useState('');
  const fileRef = useRef(null);

  const canEdit = !perms || perms.template_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError(false);
    try {
      const r = await garageFetch('getMediaLibrary', { limit: 200, with_usage: 'true' }, session);
      setAssets(Array.isArray(r?.assets) ? r.assets : []);
    } catch (e) {
      // A failed fetch and an empty bucket look identical but mean opposite things —
      // one says "upload your first image", the other "we could not read the library".
      setLoadError(true);
      setAssets([]);
      showToast(e.message || 'Could not load the library', 'error');
    }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy(true);
    setProgress([0, files.length]);
    try {
      const { urls, failures } = await uploadMany(files, session, (d, t) => setProgress([d, t]));
      if (urls.length) showToast(`Uploaded ${urls.length} image${urls.length === 1 ? '' : 's'}`, 'success');
      // Name what failed. "3 failed" in a batch of twenty is not something anyone can act on.
      if (failures.length) showToast(failures.join(' · '), 'error');
      await load();
    } finally { setBusy(false); setProgress(null); }
  }

  async function remove(a) {
    if (a.used_by?.length) {
      showToast(`In use by ${a.used_by.map((t) => t.name).join(', ')} — remove it there first`, 'error');
      return;
    }
    if (!(await confirm({
      tone: 'danger',
      title: `Delete ${cleanName(a.name)}?`,
      lede: 'This removes the file permanently.',
      points: [
        'No template currently references it',
        'Any link to it that exists outside Relay will break',
      ],
      confirmLabel: 'Delete the file',
    }))) return;
    try {
      await workerFetch('deleteMediaAsset', { path: a.path }, session);
      showToast('Deleted', 'success');
      load();
    } catch (e) {
      const m = String(e.message || '');
      showToast(m.startsWith('in_use:') ? `Still in use by ${m.slice(7)}` : (m || 'Delete failed'), 'error');
    }
  }

  async function copyUrl(a) {
    try { await navigator.clipboard.writeText(a.url); showToast('URL copied', 'success'); }
    catch { showToast('Could not copy — select the URL manually', 'error'); }
  }

  // Download via a blob, not <a download>. The bucket is on a different origin and the
  // `download` attribute is IGNORED cross-origin — the browser would navigate to the image
  // instead of saving it, which looks like the button doing nothing. Falls back to opening
  // in a tab if the fetch is blocked, so there is always some way to get the file.
  async function download(a) {
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = href;
      el.download = cleanName(a.name);   // save under the readable name, not the epoch one
      document.body.appendChild(el);
      el.click();
      el.remove();
      // Revoke on the next tick — revoking synchronously can cancel the download in Safari.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (e) {
      window.open(a.url, '_blank', 'noopener');
      showToast('Opened in a new tab — use right-click → Save image', 'error');
    }
  }

  function startRename(a) {
    setRenaming(a.path);
    // Seed with the readable name minus its extension; the extension and the epoch-ms
    // prefix are preserved server-side and are not the author's to change.
    setRenameVal(cleanName(a.name).replace(/\.[a-z0-9]+$/i, ''));
  }

  async function commitRename(a) {
    const next = renameVal.trim();
    if (!next) { showToast('Name required', 'error'); return; }
    if (next === cleanName(a.name).replace(/\.[a-z0-9]+$/i, '')) { setRenaming(null); return; }
    // Renaming is a MOVE — the old URL dies. Live templates are repointed automatically,
    // but anything already delivered to a customer keeps the dead link, so say so once
    // rather than letting it be discovered in an inbox.
    const used = a.used_by?.length || 0;
    if (!(await confirm({
      tone: 'warn',
      title: `Rename to "${next}"?`,
      lede: 'The file is moved, so its current link stops working.',
      points: [
        used
          ? <><b>{used}</b> template{used === 1 ? '' : 's'} using it will be repointed automatically</>
          : 'No template uses it, so nothing needs repointing',
        'Emails already delivered keep the old link and will show a broken image',
        'WhatsApp messages already sent are unaffected',
      ],
      confirmLabel: 'Rename the file',
    }))) return;
    setBusy(true);
    try {
      const r = await workerFetch('renameMediaAsset', { path: a.path, new_name: next }, session);
      const ref = r?.data?.references || {};
      const moved = (ref.templates || 0) + (ref.versions || 0);
      showToast(moved ? `Renamed — ${moved} reference${moved === 1 ? '' : 's'} repointed` : 'Renamed', 'success');
      setRenaming(null);
      await load();
    } catch (e) {
      const m = String(e.message || '');
      showToast(m.startsWith('name_taken:') ? `That name is already used by ${m.slice(11)}`
        : m.includes('INCONSISTENT') ? `Rename half-applied — tell Claude: ${m}`
        : (m || 'Rename failed'), 'error');
    } finally { setBusy(false); }
  }

  if (perms && !perms.relay_view) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;
  }

  const needle = q.trim().toLowerCase();
  const shown = (assets || []).filter((a) => {
    if (onlyUnused && a.used_by?.length) return false;
    if (needle && !cleanName(a.name).toLowerCase().includes(needle)) return false;
    return true;
  });
  const unusedCount = (assets || []).filter((a) => !a.used_by?.length).length;

  return (
    <div className="pg"
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { if (!canEdit) return; e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}>
      <PageHead title="Library"
        sub="Images shared by every template — WhatsApp headers and email. Upload once, use anywhere."
        actions={
          <span style={{ display: 'flex', gap: 6 }}>
            <Btn onClick={load} disabled={busy}><RefreshCw size={14} /> Refresh</Btn>
            {canEdit && (
              <Btn kind="primary" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
                <Upload size={14} /> {busy ? 'Uploading…' : 'Upload images'}
              </Btn>
            )}
          </span>
        } />

      {canEdit && (
        <div className="tw-note" style={{
          marginTop: 0, marginBottom: 12,
          border: `1px solid ${dragging ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 'var(--r-md)', transition: 'border-color .13s var(--ease)' }}>
          {dragging
            ? <b>Drop to upload.</b>
            : <>Drop image files anywhere on this page to upload them — <b>select as many as you
              like at once</b>. PNG, JPEG, GIF or WebP, up to 5MB each.</>}
        </div>
      )}

      {progress && (
        <div className="tw-note" style={{ marginTop: 0, marginBottom: 12 }}>
          Uploading {progress[0]} of {progress[1]}…
        </div>
      )}

      <Panel title="Images" count={shown.length}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ position: 'relative', flex: '1 1 220px', minWidth: 180, maxWidth: 340 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%',
              transform: 'translateY(-50%)', opacity: .5, pointerEvents: 'none' }} />
            <input className="f-inp" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search file name…" style={{ width: '100%', paddingLeft: 30 }} />
          </span>
          <Btn kind={onlyUnused ? 'primary' : 'ghost'} onClick={() => setOnlyUnused((v) => !v)}
            title="Images no template references — usually duplicates left behind by re-uploading">
            Unused only{assets ? ` · ${unusedCount}` : ''}
          </Btn>
          <span className="dim" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {assets ? `${assets.length} in the bucket` : ''}
          </span>
        </div>

        {assets == null ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : loadError ? (
          <div style={{ padding: 30, textAlign: 'center' }}>
            <ImageOff size={22} style={{ opacity: .5 }} />
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--red, #f87171)' }}>Could not load the library.</div>
            <div style={{ marginTop: 10 }}><Btn onClick={load}><RefreshCw size={14} /> Retry</Btn></div>
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon="images"
            title={assets.length === 0 ? 'No images yet' : 'Nothing matches'}
            hint={assets.length === 0
              ? 'Upload images here and they become available in every template — WhatsApp headers and email alike.'
              : 'Clear the search or the Unused filter to widen it.'} />
        ) : (
          <div style={{ padding: 14, display: 'grid', gap: 12,
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {shown.map((a) => {
              const used = a.used_by || [];
              return (
                <div key={a.path} style={{ border: '1px solid var(--bd, #2a2e35)', borderRadius: 10,
                  overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  {/* Checkerboard, so a transparent PNG does not read as a blank tile. */}
                  <span style={{ display: 'block', height: 132, background:
                    'repeating-conic-gradient(#2a2e35 0% 25%, #22252b 0% 50%) 50%/16px 16px' }}>
                    <img src={a.url} alt={cleanName(a.name)} loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                  </span>
                  <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    {renaming === a.path ? (
                      <span style={{ display: 'flex', gap: 4 }}>
                        <input className="f-inp mono" autoFocus value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(a);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          placeholder="cart-reminder"
                          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '4px 6px' }} />
                        <Btn onClick={() => commitRename(a)} disabled={busy} title="Save (Enter)"><Check size={12} /></Btn>
                        <Btn onClick={() => setRenaming(null)} disabled={busy} title="Cancel (Esc)"><X size={12} /></Btn>
                      </span>
                    ) : (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--t2, #c8ccd2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={cleanName(a.name)}>{cleanName(a.name)}</span>
                    )}
                    <span className="dim" style={{ fontSize: 10.5 }}>
                      {prettySize(a.size)} · {fmtDateTime(a.created_at)}
                    </span>
                    {/* Usage is the thing that makes a duplicate identifiable — the bucket
                        holds the same picture more than once, and only this says which
                        copy is actually wired up. */}
                    <span title={used.length ? used.map((t) => t.name).join('\n') : 'No template references this image'}>
                      {used.length
                        ? <Badge label={`used in ${used.length}`} tone="green" dot />
                        : <Badge label="unused" tone="gray" dot />}
                    </span>
                    <span style={{ display: 'flex', gap: 6, marginTop: 'auto', flexWrap: 'wrap' }}>
                      <Btn onClick={() => download(a)} title="Download this image"><Download size={14} /></Btn>
                      <Btn onClick={() => copyUrl(a)} title="Copy the public URL"><Link2 size={14} /></Btn>
                      {canEdit && (
                        <Btn onClick={() => startRename(a)} disabled={busy || renaming === a.path}
                          title="Rename — moves the file and repoints every template that uses it">
                          <Pencil size={14} />
                        </Btn>
                      )}
                      {canEdit && (
                        <Btn onClick={() => remove(a)} disabled={used.length > 0}
                          title={used.length
                            ? `Used by ${used.map((t) => t.name).join(', ')} — remove it there first`
                            : 'Delete this image'}>
                          <Trash2 size={14} />
                        </Btn>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <input ref={fileRef} type="file" accept={ACCEPT_MIME} multiple style={{ display: 'none' }}
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleFiles(f); }} />
    </div>
  );
}
