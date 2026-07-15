'use client';
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { supabase, workerFetch } from '@throttle/db';
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

const EmailEditor = forwardRef(function EmailEditor({ initialDesign, session, canEdit }, ref) {
  const holderRef = useRef(null);
  const edRef = useRef(null);
  useImperativeHandle(ref, () => ({
    export: () => (edRef.current ? exportEmail(edRef.current) : { mjml: '', html: '', text: '', design: null }),
    setDevice: (name) => { if (edRef.current) edRef.current.setDevice(name); },
    getEditor: () => edRef.current,
  }), []);
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
            try { editor.AssetManager.add(await uploadAsset(f, session)); }
            catch (err) { console.error('[email-editor] upload', err && err.message || err); }
          }
        },
      },
    });
    if (initialDesign && Object.keys(initialDesign).length) editor.loadProjectData(initialDesign);
    else editor.setComponents(BLANK_MJML);
    edRef.current = editor;
    return () => { try { editor.destroy(); } catch (_) {} edRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={holderRef} className="email-gjs" />;
});
export default EmailEditor;
