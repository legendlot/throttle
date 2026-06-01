'use client';
import { useState } from 'react';
import { supabase } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { UploadCloud } from 'lucide-react';
import { DOC_TYPES } from '../lib/format.js';
import { podiumopsPost } from '../lib/podiumopsFetch.js';

const DOC_BUCKET = 'podium-documents';

// Private-document uploader: worker mints a signed upload URL, the browser PUTs
// the file straight to the private bucket, then we record the metadata row.
export default function DocumentUploader({ employeeId, session, onUploaded }) {
  const { showToast } = useToast();
  const [docType, setDocType] = useState('resume');
  const [title, setTitle] = useState('');
  const [expires, setExpires] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) { showToast('Pick a file first', 'error'); return; }
    setBusy(true);
    try {
      const { storage_path, token } = await podiumopsPost(
        'createDocumentUploadUrl',
        { employee_id: employeeId, doc_type: docType, file_name: file.name },
        session,
      );
      if (!token) throw new Error('no upload token');
      const { error } = await supabase.storage.from(DOC_BUCKET).uploadToSignedUrl(storage_path, token, file);
      if (error) throw error;
      await podiumopsPost('recordDocument', {
        employee_id: employeeId,
        doc_type: docType,
        title: title || file.name,
        storage_path,
        file_name: file.name,
        mime_type: file.type || null,
        file_size: file.size || null,
        expires_at: expires || null,
      }, session);
      showToast('Document uploaded', 'success');
      setFile(null); setTitle(''); setExpires('');
      onUploaded && onUploaded();
    } catch (e) {
      showToast(e.message || 'Upload failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
      <select value={docType} onChange={e => setDocType(e.target.value)} style={inp(170)}>
        {DOC_TYPES.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <input placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} style={inp(160)} />
      <input type="date" title="Expiry (optional)" value={expires} onChange={e => setExpires(e.target.value)} style={inp(140)} />
      <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--text-2)' }} />
      <button onClick={upload} disabled={busy} style={uploadBtn(busy)}>
        <UploadCloud size={14} /> {busy ? 'Uploading…' : 'Upload'}
      </button>
    </div>
  );
}

const inp = (w) => ({
  background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, width: w,
});
const uploadBtn = (busy) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-green)', color: '#04130d',
  border: 'none', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontWeight: 700, fontSize: 12,
  letterSpacing: '0.04em', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
});
