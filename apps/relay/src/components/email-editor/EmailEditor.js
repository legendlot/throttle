'use client';
import { useEffect, useRef } from 'react';
import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { supabase, garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { exportEmail } from './exportEmail.js';
import { BLANK_MJML } from './blankScaffold.js';

const BUCKET = 'relay-email-assets';
const MAX_BYTES = 5 * 1024 * 1024;

async function uploadAsset(file, session) {
  if (!file.type || !file.type.startsWith('image/')) throw new Error('not an image');
  if (file.size > MAX_BYTES) throw new Error('image too large (max 5MB)');
  const r = await workerFetch('createEmailAssetUploadUrl', { file_name: file.name, mime_type: file.type }, session);
  const d = r?.data;
  if (!d?.token || !d?.storage_path) throw new Error(r?.error || 'sign failed');
  const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(d.storage_path, d.token, file);
  if (up.error) throw up.error;
  return d.public_url;
}

export default function EmailEditor({ initialDesign, initialMjml, session, onReady }) {
  const holderRef = useRef(null);
  const { showToast } = useToast();
  useEffect(() => {
    if (!holderRef.current) return undefined;
    const editor = grapesjs.init({
      container: holderRef.current,
      height: '640px',
      fromElement: false,
      storageManager: false,
      plugins: [grapesjsMjml],
      assetManager: {
        uploadFile: async (e) => {
          const files = e.dataTransfer ? e.dataTransfer.files : e.target.files;
          for (const f of files) {
            try {
              editor.AssetManager.add(await uploadAsset(f, session));
              showToast('Image uploaded', 'success');
            } catch (err) {
              console.error('[email-editor] upload', err && err.message || err);
              showToast('Upload failed: ' + (err?.message || err), 'error');
            }
          }
        },
      },
    });
    // Load order matters. A saved design_json is the editor's own round-trippable state, so it
    // always wins. Failing that, MJML SOURCE is loadable too — `setComponents` parses it into
    // real components, which is how a template authored outside the canvas can still be opened,
    // edited and cloned instead of showing a blank email. Only with neither do we scaffold.
    // (2026-08-10: added so there is one canvas-native launch template to copy from — building
    // each new campaign from the blank scaffold was the actual cost being paid.)
    if (initialDesign && Object.keys(initialDesign).length) editor.loadProjectData(initialDesign);
    else if (initialMjml && initialMjml.trim()) editor.setComponents(initialMjml);
    else editor.setComponents(BLANK_MJML);

    // Seed the asset manager from the shared library (S251).
    //
    // GrapesJS has always HAD a picker — it was just empty on every mount, because nothing
    // ever told it what was already in the bucket. So an author who had uploaded an image
    // last week saw a blank panel and re-uploaded it, and the bucket accumulated duplicates
    // of the same picture. The images were never missing; they were merely invisible.
    //
    // Async and non-blocking: the editor is fully usable before this resolves, and a
    // failure just leaves the panel as empty as it used to be — never a broken canvas.
    let cancelled = false;
    (async () => {
      try {
        const r = await garageFetch('getMediaLibrary', { limit: 200 }, session);
        if (cancelled) return;
        const assets = Array.isArray(r?.assets) ? r.assets : [];
        if (assets.length) {
          editor.AssetManager.add(assets.map((a) => ({
            type: 'image', src: a.url, name: a.name.replace(/^\d+_/, ''),
          })));
        }
      } catch (err) {
        console.error('[email-editor] library', err && err.message || err);
      }
    })();
    const api = {
      export: () => exportEmail(editor),
      setDevice: (name) => editor.setDevice(name),
      getEditor: () => editor,
    };
    if (onReady) onReady(api);
    return () => {
      // Stop the in-flight library fetch from calling AssetManager.add on a destroyed
      // editor — templates/page.js remounts this via `editorKey` on every open, and
      // Duplicate remounts it again immediately.
      cancelled = true;
      if (onReady) onReady(null);
      try { editor.destroy(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={holderRef} className="email-gjs" />;
}
