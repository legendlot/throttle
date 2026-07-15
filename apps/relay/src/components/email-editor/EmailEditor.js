'use client';
import { useEffect, useRef } from 'react';
import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { supabase, workerFetch } from '@throttle/db';
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

export default function EmailEditor({ initialDesign, session, onReady }) {
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
    if (initialDesign && Object.keys(initialDesign).length) editor.loadProjectData(initialDesign);
    else editor.setComponents(BLANK_MJML);
    const api = {
      export: () => exportEmail(editor),
      setDevice: (name) => editor.setDevice(name),
      getEditor: () => editor,
    };
    if (onReady) onReady(api);
    return () => {
      if (onReady) onReady(null);
      try { editor.destroy(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={holderRef} className="email-gjs" />;
}
