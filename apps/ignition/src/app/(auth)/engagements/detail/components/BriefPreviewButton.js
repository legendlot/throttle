'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { Modal } from '../../../../../components/ui/Modal.js';
import { Banner } from '../../../../../components/ui/index.js';
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
      <button onClick={open} disabled={busy} title="Preview the deal brief (draft)" className="ig-ghost-btn" style={{ height: 40, padding: '0 14px', background: 'transparent', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}>
        {busy ? 'Loading…' : 'Brief'}
      </button>
      {draft && (
        <Modal open onClose={() => setDraft(null)} title={`Deal brief — draft`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner tone="warning" lead="This is a draft and nothing can send it yet." style={{ fontSize: 13, lineHeight: 1.5 }}>
              The wording is a starting point — change it to what you actually want creators to read.
              Copy it out to use it today.
            </Banner>
            {(draft.warnings || []).length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--state-error-fg)', lineHeight: 1.6 }}>
                {draft.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div>
            <div style={{ display: 'flex', gap: 12, fontSize: 14, padding: '7px 0', borderTop: '1px solid var(--row-divider)' }}>
              <span style={{ color: 'var(--text-3)', width: 64, flexShrink: 0 }}>To</span>
              <span style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 0, wordBreak: 'break-all' }}>{draft.to || '— no email on record —'}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 14, padding: '7px 0', borderTop: '1px solid var(--row-divider)' }}>
              <span style={{ color: 'var(--text-3)', width: 64, flexShrink: 0 }}>Subject</span>
              <span style={{ color: 'var(--text-1)', minWidth: 0 }}>{draft.subject}</span>
            </div>
            </div>
            <pre style={{ margin: 0, padding: 14, background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-row)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--text-2)', whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto' }}>{draft.body}</pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={copy} style={{ height: 40, padding: '0 16px', background: 'var(--text-1)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {copied ? 'Copied' : 'Copy brief'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
