'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch, supabase } from '@throttle/db';
import { Spinner, Modal, useToast } from '@throttle/ui';
import { GP_PURPOSES, DIRECTION_LABEL, purposeLabel, returnState } from '../../../../lib/gatePass.js';

const GATEPASS_BUCKET = 'gate-pass-docs';
const TONE = {
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
};
const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '14px 16px' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '7px 13px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnD  = { ...btnP, background: 'var(--red, #de2a2a)' };

function Badge({ tone, children }) {
  const s = TONE[tone] || TONE.blue;
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}>{children}</span>;
}
function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d; } }
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid rgba(42,42,42,.5)' }}>
      <div style={{ width: 180, flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)', paddingTop: 2 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{children ?? '—'}</div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <DetailContent />
    </Suspense>
  );
}

function DetailContent() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const id = params?.get('id');
  const canUse = hasPermission(perms || {}, 'gate_pass');

  const [gp, setGp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState({});
  const [saving, setSaving] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [docFiles, setDocFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  async function load() {
    if (!session || !id || !canUse) return;
    setLoading(true);
    try {
      const data = await garageFetch('getGatePass', { id }, session);
      setGp(data);
    } catch { setGp(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, id]);

  function startEdit() {
    setEf({
      gate_datetime: gp.gate_datetime ? toLocalInput(gp.gate_datetime) : '',
      vehicle_no: gp.vehicle_no || '', person_name: gp.person_name || '', person_phone: gp.person_phone || '',
      transporter_name: gp.transporter_name || '', box_count: gp.box_count ?? '', purpose: gp.purpose || '',
      party_name: gp.party_name || '', reference_no: gp.reference_no || '', material_description: gp.material_description || '',
      remarks: gp.remarks || '', is_returnable: !!gp.is_returnable, expected_return_date: gp.expected_return_date || '',
    });
    setEditing(true);
  }
  function setE(k, v) { setEf((p) => ({ ...p, [k]: v })); }

  async function saveEdit() {
    setSaving(true);
    try {
      const patch = {
        id: gp.id,
        gate_datetime: ef.gate_datetime ? new Date(ef.gate_datetime).toISOString() : null,
        vehicle_no: ef.vehicle_no, person_name: ef.person_name, person_phone: ef.person_phone,
        transporter_name: ef.transporter_name, box_count: ef.box_count === '' ? null : ef.box_count,
        purpose: ef.purpose, party_name: ef.party_name, reference_no: ef.reference_no,
        material_description: ef.material_description, remarks: ef.remarks,
        is_returnable: ef.is_returnable, expected_return_date: ef.is_returnable && ef.expected_return_date ? ef.expected_return_date : null,
      };
      const res = await workerFetch('updateGatePass', { data: patch }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      showToast('Saved', 'success');
      setEditing(false);
      await load();
    } catch (e) { showToast(e.message || 'Update failed', 'error'); }
    finally { setSaving(false); }
  }

  async function doVoid() {
    if (!voidReason.trim()) { showToast('Enter a reason', 'error'); return; }
    try {
      const res = await workerFetch('voidGatePass', { data: { id: gp.id, reason: voidReason.trim() } }, session);
      if (!res.ok) throw new Error(res.error || 'Void failed');
      showToast('Gate pass voided', 'success');
      setVoidOpen(false); setVoidReason('');
      await load();
    } catch (e) { showToast(e.message || 'Void failed', 'error'); }
  }

  async function markReturned() {
    if (!window.confirm('Mark this returnable gate pass as returned?')) return;
    try {
      const res = await workerFetch('markGatePassReturned', { data: { id: gp.id } }, session);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showToast('Marked returned', 'success');
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  async function uploadDocs() {
    if (!docFiles.length) { showToast('Choose file(s) first', 'error'); return; }
    setUploading(true);
    try {
      for (const file of docFiles) {
        const r1 = await workerFetch('createGatePassDocUploadUrl', { data: { gate_pass_id: gp.id, file_name: file.name } }, session);
        if (!r1.ok || !r1.data?.token) throw new Error(r1.error || 'No upload token');
        const { storage_path, token } = r1.data;
        const up = await supabase.storage.from(GATEPASS_BUCKET).uploadToSignedUrl(storage_path, token, file);
        if (up.error) throw up.error;
        await workerFetch('recordGatePassDocument', { data: { gate_pass_id: gp.id, file_name: file.name, storage_path, mime_type: file.type || null } }, session);
      }
      showToast('Document(s) uploaded', 'success');
      setDocFiles([]);
      await load();
    } catch (e) { showToast(e.message || 'Upload failed', 'error'); }
    finally { setUploading(false); }
  }

  async function viewDoc(docId) {
    try {
      const res = await garageFetch('getGatePassDocumentDownloadUrl', { document_id: docId }, session);
      if (res?.url) window.open(res.url, '_blank');
      else showToast('Could not open document', 'error');
    } catch (e) { showToast(e.message || 'Could not open', 'error'); }
  }
  async function deleteDoc(docId) {
    if (!window.confirm('Delete this document?')) return;
    try {
      const res = await workerFetch('deleteGatePassDocument', { data: { document_id: docId } }, session);
      if (!res.ok) throw new Error(res.error || 'Delete failed');
      showToast('Deleted', 'success');
      await load();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (!canUse) return <div style={{ padding: 24, color: 'var(--t3)' }}>You don&apos;t have access to Gate Pass.</div>;
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!gp?.id) return <div style={{ padding: 24, color: 'var(--t3)' }}>Gate pass not found. <button style={btnS} onClick={() => router.push('/gate-pass')}>Back</button></div>;

  const isVoid = gp.status === 'void';
  const rst = returnState(gp);
  const purposes = GP_PURPOSES[gp.direction] || [];

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={btnS} onClick={() => router.push('/gate-pass')}>← Back</button>
          <h1 style={{ margin: 0, fontSize: 22, fontFamily: 'var(--cond)' }}>{gp.gate_pass_no}</h1>
          <Badge tone={gp.direction === 'inbound' ? 'blue' : 'orange'}>{DIRECTION_LABEL[gp.direction]}</Badge>
          {isVoid ? <Badge tone="red">Void</Badge> : <Badge tone="green">Active</Badge>}
          {rst === 'overdue' && <Badge tone="red">Return overdue</Badge>}
          {rst === 'returned' && <Badge tone="green">Returned</Badge>}
          {rst === 'pending' && <Badge tone="orange">Return pending</Badge>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btnS} onClick={() => window.open(`/gate-pass/print?id=${gp.id}`, '_blank')}>🖨 Print</button>
          {!isVoid && !editing && <button style={btnS} onClick={startEdit}>Edit</button>}
          {!isVoid && rst === 'pending' && <button style={btnS} onClick={markReturned}>Mark Returned</button>}
          {!isVoid && rst === 'overdue' && <button style={btnS} onClick={markReturned}>Mark Returned</button>}
          {!isVoid && !editing && <button style={btnD} onClick={() => setVoidOpen(true)}>Void</button>}
        </div>
      </div>

      {editing ? (
        <div style={panel}>
          <div style={phdr}><span>Edit Gate Pass</span></div>
          <div style={pbody}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={lbl}>Date &amp; time</label><input style={input} type="datetime-local" value={ef.gate_datetime} onChange={(e) => setE('gate_datetime', e.target.value)} /></div>
              <div><label style={lbl}>Purpose</label><select style={input} value={ef.purpose} onChange={(e) => setE('purpose', e.target.value)}>{purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></div>
              <div><label style={lbl}>Vehicle number</label><input style={input} value={ef.vehicle_no} onChange={(e) => setE('vehicle_no', e.target.value)} /></div>
              <div><label style={lbl}>No. of boxes</label><input style={input} type="number" min="0" value={ef.box_count} onChange={(e) => setE('box_count', e.target.value)} /></div>
              <div><label style={lbl}>Driver / person name</label><input style={input} value={ef.person_name} onChange={(e) => setE('person_name', e.target.value)} /></div>
              <div><label style={lbl}>Driver / person phone</label><input style={input} value={ef.person_phone} onChange={(e) => setE('person_phone', e.target.value)} /></div>
              <div><label style={lbl}>Transporter / courier partner</label><input style={input} value={ef.transporter_name} onChange={(e) => setE('transporter_name', e.target.value)} /></div>
              <div><label style={lbl}>Party</label><input style={input} value={ef.party_name} onChange={(e) => setE('party_name', e.target.value)} /></div>
              <div><label style={lbl}>Reference no</label><input style={input} value={ef.reference_no} onChange={(e) => setE('reference_no', e.target.value)} /></div>
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Material description</label><textarea style={{ ...input, minHeight: 50, resize: 'vertical' }} value={ef.material_description} onChange={(e) => setE('material_description', e.target.value)} /></div>
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={ef.is_returnable} onChange={(e) => setE('is_returnable', e.target.checked)} /> Returnable
              </label>
              {ef.is_returnable && <div style={{ marginTop: 8, maxWidth: 240 }}><label style={lbl}>Expected return date</label><input style={input} type="date" value={ef.expected_return_date} onChange={(e) => setE('expected_return_date', e.target.value)} /></div>}
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Remarks</label><textarea style={{ ...input, minHeight: 40, resize: 'vertical' }} value={ef.remarks} onChange={(e) => setE('remarks', e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button style={btnP} onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button style={btnS} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div style={panel}>
          <div style={phdr}><span>Details</span></div>
          <div style={pbody}>
            <Row label="Date & time">{fmtTs(gp.gate_datetime)}</Row>
            <Row label="Purpose">{purposeLabel(gp.direction, gp.purpose)}</Row>
            <Row label="Vehicle no"><span style={{ fontFamily: 'var(--mono)' }}>{gp.vehicle_no || '—'}</span></Row>
            <Row label="Driver / person">{gp.person_name || '—'}{gp.person_phone ? ` · ${gp.person_phone}` : ''}</Row>
            <Row label="Transporter / courier">{gp.transporter_name || '—'}</Row>
            <Row label="No. of boxes">{gp.box_count ?? '—'}</Row>
            <Row label="Party">{gp.party_name || '—'}</Row>
            <Row label="Reference no">{gp.reference_no || '—'}</Row>
            <Row label="Material / contents">{gp.material_description || '—'}</Row>
            <Row label="Returnable">{gp.is_returnable ? `Yes${gp.expected_return_date ? ` · expected ${fmtDate(gp.expected_return_date)}` : ''}${gp.returned_at ? ` · returned ${fmtTs(gp.returned_at)}` : ''}` : 'No'}</Row>
            <Row label="Remarks">{gp.remarks || '—'}</Row>
            {isVoid && <Row label="Void reason"><span style={{ color: '#ff7070' }}>{gp.void_reason || '—'}</span></Row>}
            <Row label="Created">{gp.created_by_name || '—'} · {fmtTs(gp.created_at)}</Row>
          </div>
        </div>
      )}

      <div style={panel}>
        <div style={phdr}><span>Documents</span></div>
        <div style={pbody}>
          {(gp.documents || []).length === 0 ? (
            <div style={{ color: 'var(--t3)', fontSize: 12, marginBottom: 10 }}>No documents attached.</div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              {gp.documents.map((d) => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(42,42,42,.5)', fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{d.file_name || d.storage_path}</span>
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>{fmtTs(d.uploaded_at)}</span>
                  <button style={btnS} onClick={() => viewDoc(d.id)}>View</button>
                  {!isVoid && <button style={{ ...btnS, color: '#ff7070' }} onClick={() => deleteDoc(d.id)}>Delete</button>}
                </div>
              ))}
            </div>
          )}
          {!isVoid && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input type="file" multiple onChange={(e) => setDocFiles(Array.from(e.target.files || []))} style={{ fontSize: 12, color: 'var(--t2)' }} />
              <button style={btnS} onClick={uploadDocs} disabled={uploading || !docFiles.length}>{uploading ? 'Uploading…' : 'Upload'}</button>
            </div>
          )}
        </div>
      </div>

      {voidOpen && (
        <Modal title="Void Gate Pass" onClose={() => setVoidOpen(false)}>
          <div style={{ padding: 4 }}>
            <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>Voiding keeps the record (it prints with a VOID watermark) but marks it cancelled. Reason is required.</p>
            <label style={lbl}>Reason</label>
            <textarea style={{ ...input, minHeight: 60 }} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button style={btnS} onClick={() => setVoidOpen(false)}>Cancel</button>
              <button style={btnD} onClick={doVoid}>Void</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function toLocalInput(ts) {
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}
