'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import PocSelect from '../../../../../components/PocSelect.js';
import { Card, KV } from './shared.js';

// The deal's owner (Reann #11). Required on new deals; older deals with none get one picked here.
export function OwnerCard({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function change({ poc_user_id, poc_name }) {
    if (!poc_user_id || poc_user_id === e.poc_user_id) return;
    setBusy(true);
    try {
      await ignitionopsPost('updateEngagement', { engagement_id: e.id, poc_user_id, poc_name }, session);
      toast(`Owner set to ${poc_name}`, 'success');
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Owner">
      {canEdit ? (
        <PocSelect value={e.poc_user_id} currentName={e.poc_name} onChange={change} session={session} disabled={busy} style={select} />
      ) : <KV label="Assigned to" value={e.poc_name || '—'} />}
      {canEdit && !e.poc_user_id && <div style={{ fontSize: 12, color: 'var(--state-warning-fg)', marginTop: 8 }}>This deal has no owner yet.</div>}
    </Card>
  );
}

const select = {
  width: '100%', height: 40, padding: '0 12px', background: 'var(--input)', color: 'var(--text-1)',
  border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', font: 'inherit', fontSize: 14,
};
