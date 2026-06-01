'use client';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, garageFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast, Modal, ConfirmModal, printWindow } from '@throttle/ui';
import { PURPOSES, STATUSES, StatusBadge, fmtTs, purposeLabel } from '../page.js';

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '14px 16px' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '7px 11px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: '#f2cd1a', border: 'none', borderRadius: 3, padding: '9px 16px', fontSize: 12, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '7px 14px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em' };
const btnD  = { background: 'rgba(222,42,42,.15)', border: '1px solid #ff7070', color: '#ff7070', borderRadius: 3, padding: '7px 14px', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em' };
const th    = { padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '6px 8px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };

const HEADER_FIELDS = ['purpose','destination','destination_contact','requester_notes','expected_return_at','notes'];

export default function DirectIssuanceDetailPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <DetailInner />
    </Suspense>
  );
}

function DetailInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const canRequest = hasPermission(perms, 'direct_issuance_request') || hasPermission(perms, 'users_manage');
  const canApprove = hasPermission(perms, 'direct_issuance_approve') || hasPermission(perms, 'users_manage');

  const [header,    setHeader]    = useState(null);
  const [items,     setItems]     = useState([]);
  const [history,   setHistory]   = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [form,      setForm]      = useState({});
  const [saving,    setSaving]    = useState(false);
  const [busy,      setBusy]      = useState(false);

  // Catalogues for item picker
  const [partsCat, setPartsCat] = useState([]);

  // Action modal state
  const [issueConfirmOpen, setIssueConfirmOpen] = useState(false);
  const [closeOpen,        setCloseOpen]        = useState(false);
  const [closeForm,        setCloseForm]        = useState({ return_note: '', return_grn_ref: '' });
  const [cancelConfirmOpen,setCancelConfirmOpen]= useState(false);

  const load = useCallback(async () => {
    if (!session || !canRequest || !id) return;
    setLoading(true);
    try {
      const r = await workerFetch('getDirectIssuance', { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      const { items: lines = [], history: hist = [], ...rest } = r.data || {};
      setHeader(rest);
      setItems(lines);
      setHistory(hist);
      const seed = {};
      HEADER_FIELDS.forEach(k => { seed[k] = rest[k] ?? ''; });
      setForm(seed);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
    } finally { setLoading(false); }
  }, [session, canRequest, id, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getProcurementParts', {}, session)
      .then(rows => setPartsCat(Array.isArray(rows) ? rows : []))
      .catch(() => setPartsCat([]));
  }, [session]);

  const isDraft  = header?.status === 'draft';
  const isIssued = header?.status === 'issued';
  const isClosed = header?.status === 'closed' || header?.status === 'cancelled';

  const dirty = useMemo(() => {
    if (!header || !isDraft) return false;
    return HEADER_FIELDS.some(k => (form[k] ?? '') !== (header[k] ?? ''));
  }, [form, header, isDraft]);

  async function saveHeader(replaceItems) {
    setSaving(true);
    try {
      const payload = { id };
      HEADER_FIELDS.forEach(k => {
        if ((form[k] ?? '') !== (header[k] ?? '')) payload[k] = form[k] || null;
      });
      if (replaceItems) payload.items = items.map(it => ({
        kind:      it.kind,
        part_code: it.part_code,
        unit_upc:  it.unit_upc,
        part_name: it.part_name,
        product:   it.product,
        qty:       it.qty,
        notes:     it.notes,
      }));
      const r = await workerFetch('saveDirectIssuance', { data: payload }, session);
      if (!r?.ok) { toast(r?.error || 'Save failed', 'error'); return false; }
      toast('Saved', 'success');
      load();
      return true;
    } catch (e) { toast(e.message || 'Failed', 'error'); return false; }
    finally { setSaving(false); }
  }

  async function approveAndIssue() {
    if (items.length === 0) { toast('Add at least one item', 'error'); return; }
    // Always save items first to make sure they're persisted
    setBusy(true);
    try {
      // Persist items first
      const persisted = await saveHeader(true);
      if (!persisted) return;
      const r = await workerFetch('approveAndIssue', { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Issue failed', 'error'); return; }
      toast(`${header.issue_no} issued — ${r.data.parts_updated} parts, ${r.data.units_flipped} units`, 'success');
      setIssueConfirmOpen(false);
      load();
      // Trigger sticker print after a brief render
      setTimeout(() => printSticker(), 400);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function closeIssuance() {
    setBusy(true);
    try {
      const r = await workerFetch('closeDirectIssuance', { data: { id, ...closeForm } }, session);
      if (!r?.ok) { toast(r?.error || 'Close failed', 'error'); return; }
      toast('Closed', 'success');
      setCloseOpen(false);
      setCloseForm({ return_note: '', return_grn_ref: '' });
      load();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function cancelIssuance() {
    setBusy(true);
    try {
      const r = await workerFetch('cancelDirectIssuance', { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Cancel failed', 'error'); return; }
      toast('Cancelled', 'success');
      setCancelConfirmOpen(false);
      load();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  function printSticker() {
    if (!header) return;
    printWindow(buildStickerHtml({ ...header, items }), `${header.issue_no} sticker`);
  }

  function addPartLine() {
    setItems(prev => [...prev, { kind: 'part', part_code: '', part_name: '', product: '', qty: 1, notes: '' }]);
  }
  function addUnitLine() {
    setItems(prev => [...prev, { kind: 'unit', unit_upc: '', part_name: '', qty: 1, notes: '' }]);
  }
  function updateItem(idx, patch) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  }
  function removeItem(idx) {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }
  function pickPart(idx, partCode) {
    const p = partsCat.find(x => x.part_code === partCode);
    updateItem(idx, {
      part_code: partCode,
      part_name: p?.part_name || '',
      product:   p?.product   || '',
    });
  }

  if (!canRequest) {
    return <div style={{ padding: 16 }}><EmptyState title="Access denied" /></div>;
  }
  if (!id) {
    return <div style={{ padding: 16 }}><EmptyState title="Missing id" /></div>;
  }
  if (loading && !header) {
    return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  }
  if (!header) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState title="Not found" />
        <button onClick={() => router.push('/direct-issuance')} style={btnS}>← Back</button>
      </div>
    );
  }

  const totalParts = items.filter(i => i.kind === 'part').reduce((s, i) => s + Number(i.qty || 0), 0);
  const totalUnits = items.filter(i => i.kind === 'unit').length;

  return (
    <div style={{ padding: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={() => router.push('/direct-issuance')} style={btnS}>← Back</button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 18, color: '#f2cd1a', fontWeight: 700 }}>{header.issue_no}</span>
        <StatusBadge status={header.status} />
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>
          Requested by <strong style={{ color: 'var(--t2)' }}>{header.requester_name || '—'}</strong> · {fmtTs(header.created_at)}
        </span>
        {header.issued_at && (
          <span style={{ fontSize: 11, color: 'var(--t3)' }}>
            · Issued by <strong style={{ color: 'var(--t2)' }}>{header.approver_name || '—'}</strong> · {fmtTs(header.issued_at)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* Action buttons by state */}
        {isDraft && canApprove && (
          <button onClick={() => setIssueConfirmOpen(true)} style={btnP} disabled={busy || items.length === 0}>
            APPROVE &amp; ISSUE
          </button>
        )}
        {isDraft && (
          <button onClick={() => setCancelConfirmOpen(true)} style={btnD} disabled={busy}>CANCEL DRAFT</button>
        )}
        {isIssued && (
          <button onClick={printSticker} style={btnS}>🖨 PRINT STICKER</button>
        )}
        {isIssued && canApprove && (
          <button onClick={() => setCloseOpen(true)} style={btnS} disabled={busy}>MARK CLOSED</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* LEFT: editable header + items */}
        <div>
          <div style={panel}>
            <div style={phdr}>
              <span>Details</span>
              {isDraft && dirty && (
                <button onClick={() => saveHeader(false)} style={btnP} disabled={saving}>
                  {saving ? 'SAVING…' : 'SAVE HEADER'}
                </button>
              )}
            </div>
            <div style={pbody}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={lbl}>Purpose</label>
                  <select value={form.purpose || ''} onChange={e => setForm({ ...form, purpose: e.target.value })} style={input} disabled={!isDraft}>
                    {PURPOSES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Expected return date</label>
                  <input type="date" value={form.expected_return_at || ''} onChange={e => setForm({ ...form, expected_return_at: e.target.value })} style={input} disabled={!isDraft} />
                </div>
                <div style={{ gridColumn: '1 / 3' }}>
                  <label style={lbl}>Destination / recipient</label>
                  <input value={form.destination || ''} onChange={e => setForm({ ...form, destination: e.target.value })} style={input} disabled={!isDraft} />
                </div>
                <div style={{ gridColumn: '1 / 3' }}>
                  <label style={lbl}>Contact</label>
                  <input value={form.destination_contact || ''} onChange={e => setForm({ ...form, destination_contact: e.target.value })} style={input} disabled={!isDraft} />
                </div>
                <div style={{ gridColumn: '1 / 3' }}>
                  <label style={lbl}>Reason / context</label>
                  <textarea rows={2} value={form.requester_notes || ''} onChange={e => setForm({ ...form, requester_notes: e.target.value })} style={{ ...input, resize: 'vertical' }} disabled={!isDraft} />
                </div>
                <div style={{ gridColumn: '1 / 3' }}>
                  <label style={lbl}>Internal notes</label>
                  <textarea rows={2} value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...input, resize: 'vertical' }} disabled={!isDraft} />
                </div>
              </div>
            </div>
          </div>

          {/* Items table */}
          <div style={panel}>
            <div style={phdr}>
              <span>Items · {items.length} lines{totalParts ? ` · ${totalParts} parts` : ''}{totalUnits ? ` · ${totalUnits} units` : ''}</span>
              {isDraft && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={addPartLine} style={btnS}>+ PART</button>
                  <button onClick={addUnitLine} style={btnS}>+ UNIT</button>
                  <button onClick={() => saveHeader(true)} style={btnP} disabled={saving}>
                    {saving ? 'SAVING…' : 'SAVE ITEMS'}
                  </button>
                </div>
              )}
            </div>
            <div style={pbody}>
              {items.length === 0 ? (
                <div style={{ padding: 18, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
                  {isDraft ? 'No items yet. Click + Part or + Unit to add.' : 'No items.'}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={{ ...th, width: 70 }}>Kind</th>
                      <th style={th}>Identifier</th>
                      <th style={th}>Name / details</th>
                      <th style={{ ...th, width: 80, textAlign: 'right' }}>Qty</th>
                      <th style={th}>Notes</th>
                      {isDraft && <th style={{ ...th, width: 50 }}></th>}
                    </tr></thead>
                    <tbody>
                      {items.map((it, idx) => (
                        <tr key={idx}>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: it.kind === 'part' ? '#7b93ff' : '#4ade80', textTransform: 'uppercase' }}>
                            {it.kind}
                          </td>
                          <td style={td}>
                            {isDraft ? (
                              it.kind === 'part' ? (
                                <input
                                  list={`parts-list-${idx}`}
                                  value={it.part_code || ''}
                                  onChange={e => pickPart(idx, e.target.value)}
                                  placeholder="part_code"
                                  style={{ ...input, fontFamily: 'var(--mono)', fontSize: 11 }}
                                />
                              ) : (
                                <input
                                  value={it.unit_upc || ''}
                                  onChange={e => updateItem(idx, { unit_upc: e.target.value.trim() })}
                                  placeholder="LOT-NNNNNNNN"
                                  style={{ ...input, fontFamily: 'var(--mono)', fontSize: 11 }}
                                />
                              )
                            ) : (
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                                {it.kind === 'part' ? it.part_code : it.unit_upc}
                              </span>
                            )}
                            {isDraft && it.kind === 'part' && (
                              <datalist id={`parts-list-${idx}`}>
                                {partsCat.slice(0, 500).map(p => (
                                  <option key={p.part_code} value={p.part_code}>{p.part_name}</option>
                                ))}
                              </datalist>
                            )}
                          </td>
                          <td style={td}>
                            {isDraft ? (
                              <input
                                value={it.part_name || ''}
                                onChange={e => updateItem(idx, { part_name: e.target.value })}
                                placeholder="display label"
                                style={input}
                              />
                            ) : (it.part_name || '—')}
                          </td>
                          <td style={{ ...td, textAlign: 'right' }}>
                            {isDraft && it.kind === 'part' ? (
                              <input
                                type="number"
                                min="1"
                                value={it.qty}
                                onChange={e => updateItem(idx, { qty: Math.max(1, parseInt(e.target.value) || 1) })}
                                style={{ ...input, fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right', maxWidth: 70 }}
                              />
                            ) : (
                              <span style={{ fontFamily: 'var(--mono)' }}>{it.qty}</span>
                            )}
                          </td>
                          <td style={td}>
                            {isDraft ? (
                              <input
                                value={it.notes || ''}
                                onChange={e => updateItem(idx, { notes: e.target.value })}
                                style={input}
                              />
                            ) : (it.notes || '—')}
                          </td>
                          {isDraft && (
                            <td style={{ ...td, textAlign: 'center' }}>
                              <button onClick={() => removeItem(idx)} style={{ background: 'transparent', border: 'none', color: '#ff7070', cursor: 'pointer', fontSize: 14 }}>×</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Return / closure info if present */}
          {(header.returned_at || header.return_note || header.return_grn_ref) && (
            <div style={panel}>
              <div style={phdr}><span>Return / Closure Info</span></div>
              <div style={pbody}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lbl}>Returned at</label>
                    <div style={{ fontSize: 12 }}>{fmtTs(header.returned_at)}</div>
                  </div>
                  <div>
                    <label style={lbl}>GRN reference</label>
                    <div style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{header.return_grn_ref || '—'}</div>
                  </div>
                  <div style={{ gridColumn: '1 / 3' }}>
                    <label style={lbl}>Return note</label>
                    <div style={{ fontSize: 12 }}>{header.return_note || '—'}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: history */}
        <div>
          <div style={panel}>
            <div style={phdr}><span>History · {history.length}</span></div>
            <div style={{ ...pbody, maxHeight: 520, overflowY: 'auto' }}>
              {history.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>No events</div>
              ) : history.map(h => (
                <div key={h.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid rgba(42,42,42,.5)' }}>
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 2 }}>
                    {fmtTs(h.created_at)} · {h.actor_name || '—'}
                  </div>
                  {h.event_type === 'created' && (
                    <div style={{ fontSize: 12, color: 'var(--t2)' }}>Created draft</div>
                  )}
                  {h.event_type === 'issued' && (
                    <div style={{ fontSize: 12, color: '#f2cd1a' }}>
                      Approved &amp; issued{h.note && <span style={{ color: 'var(--t2)' }}> — &ldquo;{h.note}&rdquo;</span>}
                    </div>
                  )}
                  {h.event_type === 'closed' && (
                    <div style={{ fontSize: 12, color: '#4ade80' }}>Marked closed</div>
                  )}
                  {h.event_type === 'returned' && (
                    <div style={{ fontSize: 12, color: '#4ade80' }}>
                      Closed with return data
                      {h.note && <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 2, fontStyle: 'italic' }}>&ldquo;{h.note}&rdquo;</div>}
                    </div>
                  )}
                  {h.event_type === 'cancelled' && (
                    <div style={{ fontSize: 12, color: '#ff7070' }}>Cancelled</div>
                  )}
                  {h.event_type === 'updated' && (
                    <div style={{ fontSize: 12, color: 'var(--t2)' }}>
                      Updated: {Object.keys(h.changes || {}).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Approve & Issue confirm */}
      {issueConfirmOpen && (
        <Modal open onClose={() => setIssueConfirmOpen(false)} size="md"
               title="Approve & Issue"
               confirmLabel={busy ? 'ISSUING…' : 'CONFIRM ISSUE'}
               onConfirm={approveAndIssue} loading={busy}>
          <div style={{ fontSize: 13, color: 'var(--t1)', marginBottom: 10 }}>
            This will:
          </div>
          <ul style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6, paddingLeft: 20, marginBottom: 12 }}>
            {totalParts > 0 && <li>Issue <strong>{totalParts}</strong> total parts from stock — stock_ledger updated</li>}
            {totalUnits > 0 && <li>Flip <strong>{totalUnits}</strong> unit(s) to <code>direct_issued</code> status</li>}
            <li>Stamp you as the issuer + open the sticker print</li>
          </ul>
          <div style={{ fontSize: 11, color: 'var(--t3)', padding: 8, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 3 }}>
            This action is irreversible. To &ldquo;undo&rdquo;, you&apos;d need to GRN the items back.
          </div>
        </Modal>
      )}

      {/* Close modal */}
      {closeOpen && (
        <Modal open onClose={() => setCloseOpen(false)} size="md"
               title="Mark Closed"
               confirmLabel={busy ? 'CLOSING…' : 'CONFIRM CLOSE'}
               onConfirm={closeIssuance} loading={busy}>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 12 }}>
            If items came back to the warehouse, log the GRN reference. Stock is <strong>not</strong> auto-reversed — the physical GRN flow handles that.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={lbl}>Return note (optional)</label>
              <textarea rows={2} value={closeForm.return_note} onChange={e => setCloseForm({ ...closeForm, return_note: e.target.value })} style={{ ...input, resize: 'vertical' }} />
            </div>
            <div>
              <label style={lbl}>Linked GRN (optional)</label>
              <input value={closeForm.return_grn_ref} onChange={e => setCloseForm({ ...closeForm, return_grn_ref: e.target.value })} placeholder="e.g. GRN-079" style={input} />
            </div>
          </div>
        </Modal>
      )}

      {/* Cancel confirm */}
      {cancelConfirmOpen && (
        <ConfirmModal
          open
          title="Cancel draft?"
          message="This draft will be marked cancelled. No stock will be affected."
          onCancel={() => setCancelConfirmOpen(false)}
          onConfirm={cancelIssuance}
          confirmLabel="CANCEL DRAFT"
          loading={busy}
        />
      )}
    </div>
  );
}

function buildStickerHtml(di) {
  const items = di.items || [];
  const rows = items.map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${it.kind === 'part' ? (it.part_code || '') : (it.unit_upc || '')}</td>
      <td>${(it.part_name || '').replace(/</g, '&lt;')}</td>
      <td style="text-align:right">${it.qty || 1}</td>
    </tr>
  `).join('');
  const dest = (di.destination || '—').replace(/</g, '&lt;');
  const contact = di.destination_contact ? `<div class="contact">${di.destination_contact.replace(/</g, '&lt;')}</div>` : '';
  const purpose = di.purpose ? di.purpose.replace(/_/g, ' ').toUpperCase() : '';
  const issuedAt = di.issued_at ? new Date(di.issued_at).toLocaleString('en-IN') : new Date().toLocaleString('en-IN');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${di.issue_no}</title>
<style>
  @page { size: 100mm 150mm; margin: 5mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #000; margin: 0; padding: 0; font-size: 11pt; }
  .header { border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .di-no { font-size: 22pt; font-weight: 800; letter-spacing: 0.05em; }
  .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
  .value { font-size: 11pt; font-weight: 600; margin-bottom: 6px; }
  .contact { font-size: 9pt; color: #444; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { font-size: 9pt; padding: 3px 4px; text-align: left; border-bottom: 1px solid #ccc; }
  th { background: #eee; font-weight: 700; }
  .footer { margin-top: 8px; font-size: 8pt; color: #777; border-top: 1px solid #000; padding-top: 6px; }
</style>
</head><body>
  <div class="header">
    <div class="di-no">${di.issue_no}</div>
    <div class="label" style="margin-top:4px">${purpose}</div>
  </div>
  <div class="label">Recipient</div>
  <div class="value">${dest}</div>
  ${contact}
  <table>
    <thead><tr><th>#</th><th>Code / UPC</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">Issued ${issuedAt} · This is a physical accountability tag.</div>
</body></html>`;
}
