'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, supabase } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { GP_PURPOSES } from '../../../../lib/gatePass.js';

const GATEPASS_BUCKET = 'gate-pass-docs';
const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16, padding: '16px 18px' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '9px 18px', fontSize: 13, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const field = { marginBottom: 14 };

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NewGatePassPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const canUse = hasPermission(perms || {}, 'gate_pass');

  const [direction, setDirection] = useState('inbound');
  const [f, setF] = useState({
    gate_datetime: nowLocal(), vehicle_no: '', person_name: '', person_phone: '',
    transporter_name: '', box_count: '', purpose: 'material_receipt', party_name: '',
    reference_no: '', material_description: '', remarks: '',
  });
  const [isReturnable, setIsReturnable] = useState(false);
  const [expReturn, setExpReturn] = useState('');
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  function set(k, v) { setF((p) => ({ ...p, [k]: v })); }
  function changeDirection(dir) {
    setDirection(dir);
    set('purpose', GP_PURPOSES[dir][0].key); // reset purpose to a valid one for the new direction
  }

  async function submit() {
    if (!f.vehicle_no.trim() && !f.person_name.trim()) { showToast('Enter a vehicle number or person name', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        direction,
        gate_datetime: f.gate_datetime ? new Date(f.gate_datetime).toISOString() : null,
        vehicle_no: f.vehicle_no, person_name: f.person_name, person_phone: f.person_phone,
        transporter_name: f.transporter_name,
        box_count: f.box_count === '' ? null : f.box_count,
        purpose: f.purpose, party_name: f.party_name, reference_no: f.reference_no,
        material_description: f.material_description, remarks: f.remarks,
        is_returnable: isReturnable,
        expected_return_date: isReturnable && expReturn ? expReturn : null,
      };
      const res = await workerFetch('createGatePass', { data: payload }, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      const gp = res.data;
      const id = gp?.id;

      // Upload any selected documents against the new pass (client-side loop — each
      // workerFetch is its own worker invocation, so the 50-subrequest cap doesn't apply).
      for (const file of files) {
        try {
          const r1 = await workerFetch('createGatePassDocUploadUrl', { data: { gate_pass_id: id, file_name: file.name } }, session);
          if (!r1.ok || !r1.data?.token) throw new Error(r1.error || 'No upload token');
          const { storage_path, token } = r1.data;
          const up = await supabase.storage.from(GATEPASS_BUCKET).uploadToSignedUrl(storage_path, token, file);
          if (up.error) throw up.error;
          await workerFetch('recordGatePassDocument', { data: { gate_pass_id: id, file_name: file.name, storage_path, mime_type: file.type || null } }, session);
        } catch (e) { showToast(`Doc "${file.name}" failed: ${e.message || e}`, 'error'); }
      }

      showToast(`Gate pass ${gp?.gate_pass_no || ''} created`, 'success');
      router.push(`/gate-pass/detail?id=${id}`);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
    } finally { setSaving(false); }
  }

  if (!canUse) return <div style={{ padding: 24, color: 'var(--t3)' }}>You don&apos;t have access to Gate Pass.</div>;

  const purposes = GP_PURPOSES[direction];

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button style={btnS} onClick={() => router.push('/gate-pass')}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: 'var(--cond)' }}>New Gate Pass</h1>
      </div>

      <div style={panel}>
        <div style={field}>
          <label style={lbl}>Direction</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['inbound', 'outbound'].map((d) => (
              <button key={d} type="button" onClick={() => changeDirection(d)}
                style={{ ...btnS, flex: 1, padding: '10px', fontWeight: 700, textTransform: 'uppercase',
                  background: direction === d ? 'var(--accent, #213ce2)' : 'transparent',
                  color: direction === d ? '#fff' : 'var(--t2)', borderColor: direction === d ? 'var(--accent, #213ce2)' : 'var(--border)' }}>
                {d === 'inbound' ? 'Inbound (entry)' : 'Outbound (exit)'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={field}>
            <label style={lbl}>Date &amp; time</label>
            <input style={input} type="datetime-local" value={f.gate_datetime} onChange={(e) => set('gate_datetime', e.target.value)} />
          </div>
          <div style={field}>
            <label style={lbl}>Purpose</label>
            <select style={input} value={f.purpose} onChange={(e) => set('purpose', e.target.value)}>
              {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={lbl}>Vehicle number</label>
            <input style={input} value={f.vehicle_no} onChange={(e) => set('vehicle_no', e.target.value)} placeholder="KA01 AB 1234" />
          </div>
          <div style={field}>
            <label style={lbl}>No. of boxes</label>
            <input style={input} type="number" min="0" value={f.box_count} onChange={(e) => set('box_count', e.target.value)} />
          </div>
          <div style={field}>
            <label style={lbl}>Driver / person name</label>
            <input style={input} value={f.person_name} onChange={(e) => set('person_name', e.target.value)} />
          </div>
          <div style={field}>
            <label style={lbl}>Driver / person phone</label>
            <input style={input} value={f.person_phone} onChange={(e) => set('person_phone', e.target.value)} />
          </div>
          <div style={field}>
            <label style={lbl}>Transporter / courier partner</label>
            <input style={input} value={f.transporter_name} onChange={(e) => set('transporter_name', e.target.value)} placeholder="Delhivery / vendor's own / walk-in" />
          </div>
          <div style={field}>
            <label style={lbl}>Party ({direction === 'inbound' ? 'from' : 'to'})</label>
            <input style={input} value={f.party_name} onChange={(e) => set('party_name', e.target.value)} placeholder="Vendor / company name" />
          </div>
          <div style={field}>
            <label style={lbl}>Reference no (PO / invoice / RMA)</label>
            <input style={input} value={f.reference_no} onChange={(e) => set('reference_no', e.target.value)} />
          </div>
        </div>

        <div style={field}>
          <label style={lbl}>Material description / contents</label>
          <textarea style={{ ...input, minHeight: 54, resize: 'vertical' }} value={f.material_description} onChange={(e) => set('material_description', e.target.value)} placeholder="e.g. 10 cartons BLDC motors" />
        </div>

        <div style={field}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t1)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isReturnable} onChange={(e) => setIsReturnable(e.target.checked)} />
            Returnable (goods expected to come back — e.g. tools, moulds, job-work)
          </label>
          {isReturnable && (
            <div style={{ marginTop: 8, maxWidth: 240 }}>
              <label style={lbl}>Expected return date</label>
              <input style={input} type="date" value={expReturn} onChange={(e) => setExpReturn(e.target.value)} />
            </div>
          )}
        </div>

        <div style={field}>
          <label style={lbl}>Remarks</label>
          <textarea style={{ ...input, minHeight: 44, resize: 'vertical' }} value={f.remarks} onChange={(e) => set('remarks', e.target.value)} />
        </div>

        <div style={field}>
          <label style={lbl}>Documents (invoices / photos — optional, multiple)</label>
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} style={{ fontSize: 12, color: 'var(--t2)' }} />
          {files.length > 0 && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{files.length} file(s) selected</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button style={btnP} onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Create Gate Pass'}</button>
          <button style={btnS} onClick={() => router.push('/gate-pass')} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
