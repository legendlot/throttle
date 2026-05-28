'use client';
import { useEffect, useState } from 'react';
import { UserCheck, UserPlus, Users } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { csopsGet, csopsPost } from '../lib/csopsFetch.js';

// Surfaces ticket assignment on the detail page with role-aware controls.
//
//  Operator (cs_ticket_manage, no reassign):
//    - Unassigned         → "Claim" button (self-assign)
//    - Assigned to me     → "Assigned to you" badge, no action
//    - Assigned to other  → "Assigned to <name>" read-only label
//
//  Team Lead+ (cs_ticket_reassign or cs_ticket_admin):
//    - Anyone selectable from agents dropdown; "Claim" shortcut on unassigned.
//
// The worker enforces the same split (assignAgent splits self vs cross-user) —
// this component mirrors server-side rules for UX clarity only.

export default function AssignmentControl({ ticket, session, onChanged }) {
  const { user, perms } = useAuth();
  const myId = user?.id;
  const canManage   = !!perms?.cs_ticket_manage;
  const canReassign = !!perms?.cs_ticket_reassign || !!perms?.cs_ticket_admin;

  const assignedId   = ticket?.assigned_agent_id;
  const assignedName = ticket?.assigned_agent_name;
  const isUnassigned = !assignedId;
  const isMine       = assignedId && assignedId === myId;

  const [agents, setAgents] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!canReassign || !session) return;
    csopsGet('getAgents', {}, session).then(setAgents).catch(() => setAgents([]));
  }, [canReassign, session]);

  async function claim() {
    if (!myId) return;
    setBusy(true); setError(null);
    try {
      await csopsPost('assignAgent', { ticket_id: ticket.id, agent_id: myId }, session);
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function reassign(agent_id) {
    if (!agent_id) return;
    setBusy(true); setError(null);
    try {
      await csopsPost('assignAgent', { ticket_id: ticket.id, agent_id }, session);
      setShowPicker(false);
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  // Render branches
  if (!canManage) {
    return (
      <Row label="Assigned">
        <span style={{ color: 'var(--t2)' }}>{assignedName || '—'}</span>
      </Row>
    );
  }

  if (isUnassigned) {
    return (
      <Row label="Assigned">
        <div style={{ display:'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={claim} disabled={busy} style={btnPrimary}>
            <UserPlus size={12} /> {busy ? 'Claiming…' : 'Claim'}
          </button>
          {canReassign && (
            <button onClick={() => setShowPicker(true)} style={btnSecondary}>
              <Users size={12} /> Assign to…
            </button>
          )}
          {error && <ErrText>{error}</ErrText>}
        </div>
        {showPicker && canReassign && (
          <AgentPicker agents={agents} onPick={reassign} onClose={() => setShowPicker(false)} busy={busy} />
        )}
      </Row>
    );
  }

  // Assigned (either me or someone else)
  return (
    <Row label="Assigned">
      <div style={{ display:'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={isMine ? minePill : { color: 'var(--t1)', fontWeight: 500 }}>
          {isMine ? <><UserCheck size={11} /> You ({assignedName})</> : assignedName}
        </span>
        {canReassign && (
          <button onClick={() => setShowPicker(true)} disabled={busy} style={btnSecondary}>
            <Users size={12} /> Reassign
          </button>
        )}
        {error && <ErrText>{error}</ErrText>}
      </div>
      {showPicker && canReassign && (
        <AgentPicker agents={agents} onPick={reassign} onClose={() => setShowPicker(false)} busy={busy} currentId={assignedId} />
      )}
    </Row>
  );
}

function AgentPicker({ agents, onPick, onClose, busy, currentId }) {
  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.5)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:'var(--surface-1, var(--surface))',
        border:'1px solid var(--border-1, var(--border))',
        borderRadius:10, padding:20, width:380, maxWidth:'92vw', maxHeight:'80vh', overflowY:'auto',
      }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Assign to agent</h3>
        {agents.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 13, padding: 16, textAlign: 'center' }}>No eligible agents.</div>
        ) : agents.map(a => (
          <button key={a.id} onClick={() => onPick(a.id)} disabled={busy || a.id === currentId}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '8px 12px', marginBottom: 4,
              background: a.id === currentId ? 'var(--surface-2)' : 'transparent',
              border: '1px solid var(--border-1, var(--border))', borderRadius: 6,
              color: 'var(--t1)', fontSize: 13, cursor: a.id === currentId ? 'default' : 'pointer',
              textAlign: 'left',
            }}>
            <span>{a.full_name}</span>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>{a.role}</span>
          </button>
        ))}
        <div style={{ display:'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'var(--space-2)' }}>
      <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      {children}
    </div>
  );
}

function ErrText({ children }) {
  return <span style={{ color: '#dc2626', fontSize: 11 }}>{children}</span>;
}

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px',
  background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 5, fontWeight: 600, cursor: 'pointer', fontSize: 12,
};
const btnSecondary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px',
  background: 'transparent', color: 'var(--t2)',
  border: '1px solid var(--border-1, var(--border))', borderRadius: 5, cursor: 'pointer', fontSize: 12,
};
const minePill = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 8px', borderRadius: 999,
  background: 'rgba(34,197,94,0.15)', color: '#16a34a',
  fontSize: 12, fontWeight: 600,
};
