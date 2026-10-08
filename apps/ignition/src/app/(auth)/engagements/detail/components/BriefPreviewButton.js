'use client';
import { useState } from 'react';
import { Modal, useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../../../lib/ignitionopsFetch.js';

// Deal brief — DRAFT ONLY (S313). Shows exactly what would go to the creator so the wording can
// be argued with before anything is armed. There is no Send button and that is deliberate: the
// send path needs a Relay template and an influencer comms profile, neither of which exists yet.
// Copy-to-clipboard is the honest interim — Reann can paste it into her own email today.
export function BriefPreviewButton({ engagementId, session }) {
  const { showToast: toast } = useToast();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function open() {
    setBusy(true);
    try {
      const r = await ignitionopsGet('getDealBriefPreview', { engagement_id: engagementId }, session);
      setDraft(r);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { toast('Could not copy — select the text and copy it manually', 'error'); }
  }

  return (
    <>
      <button onClick={open} disabled={busy} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Loading…' : 'Preview brief'}
      </button>
      {draft && (
        <Modal open onClose={() => setDraft(null)} title={`Deal brief — draft`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: 10, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.5 }}>
              <strong>This is a draft and nothing can send it yet.</strong> The wording is a starting
              point — change it to what you actually want creators to read. Copy it out to use it today.
            </div>
            {(draft.warnings || []).length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--state-error-fg)', lineHeight: 1.6 }}>
                {draft.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              To: <span style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{draft.to || '— no email on record —'}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              Subject: <span style={{ color: 'var(--text-1)' }}>{draft.subject}</span>
            </div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto' }}>{draft.body}</pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={copy} style={{ padding: '6px 12px', background: 'var(--surface-3)', color: copied ? '#4ade80' : 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>
                {copied ? 'Copied' : 'Copy brief'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
