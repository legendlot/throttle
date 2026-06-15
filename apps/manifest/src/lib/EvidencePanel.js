'use client';
import { useState } from 'react';
import { garageFetch, workerFetch, supabase } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { panelStyle, panelHeaderStyle, panelBodyStyle, selectStyle, btnSecondary, StatusBadge, fmtDate, titleCase } from './manifestui.js';

const DOC_BUCKET = 'manifest-docs';
const DOC_TYPES = ['pi','po','bank_receipt','loading_photo','unloading_photo','packing_list','bl_awb','customs_doc','sf_invoice','other'];

// Shared evidence uploader/list. refField = the documents FK column for this scope
// (e.g. 'order_id', 'shipment_id'). perms drives upload/delete visibility.
export default function EvidencePanel({ scope, refId, refField, docs = [], session, perms, onChange }) {
  const toast = useToast();
  const [docType, setDocType] = useState('pi');
  const [busy, setBusy] = useState(false);

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const up = await workerFetch('createDocumentUploadUrl', { data: { scope, doc_type: docType, file_name: file.name } }, session);
      if (!up.ok) throw new Error(up.error || 'sign failed');
      const { error } = await supabase.storage.from(DOC_BUCKET).uploadToSignedUrl(up.data.storage_path, up.data.token, file);
      if (error) throw error;
      const rec = await workerFetch('recordDocument', { data: { scope, [refField]: refId, doc_type: docType, file_name: file.name, storage_path: up.data.storage_path, mime_type: file.type } }, session);
      if (!rec.ok) throw new Error(rec.error || 'record failed');
      toast.success('Uploaded'); onChange?.();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }
  async function open(path) {
    try { const r = await garageFetch('getDocumentDownloadUrl', { storage_path: path }, session); if (r?.url) window.open(r.url, '_blank'); }
    catch (e) { toast.error(e.message); }
  }
  async function remove(id) {
    if (!confirm('Delete this document?')) return;
    const r = await workerFetch('deleteDocument', { data: { id } }, session);
    if (r.ok) { toast.success('Deleted'); onChange?.(); } else toast.error(r.error || 'delete failed');
  }

  const canUpload = perms?.doc_manage || perms?.sf_evidence_upload;

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        <span>Evidence ({docs.length})</span>
        {canUpload && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select style={{ ...selectStyle, padding: '4px 8px' }} value={docType} onChange={e => setDocType(e.target.value)}>
              {DOC_TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}
            </select>
            <label style={{ ...btnSecondary, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Uploading…' : 'Upload'}
              <input type="file" hidden disabled={busy} onChange={e => upload(e.target.files?.[0])} />
            </label>
          </span>
        )}
      </div>
      <div style={panelBodyStyle}>
        {docs.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 12 }}>No documents yet</div>}
        {docs.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12 }}>
            <StatusBadge label={titleCase(d.doc_type)} tone="blue" />
            <a onClick={() => open(d.storage_path)} style={{ cursor: 'pointer', color: 'var(--yellow)', flex: 1 }}>{d.file_name || d.storage_path.split('/').pop()}</a>
            <span style={{ color: 'var(--t3)', fontSize: 10 }}>{d.uploaded_by_name} · {fmtDate(d.created_at)}</span>
            {perms?.doc_manage && <button style={{ background: 'none', border: 'none', color: '#ff7070', cursor: 'pointer' }} onClick={() => remove(d.id)}>×</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
