'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { Combobox } from '@throttle/ui';
import { X, Lock, Trash2, UserPlus, Crown, Users } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { planErrorText } from '../lib/plan.js';

/**
 * Owner-only space settings: rename, share with teams, manage members, transfer ownership, archive.
 * A team share (P1, migration 0034) opens the space to every current member of that team, like membership;
 * the Founders' space is never team-shared.
 * Membership keys on auth user_id, so only employees with a linked login can be added
 * (login-less Podium staff are non-selectable). RULE-DOCKET-003.
 */
export function SpaceSettings({ space, session, employees, showToast, onClose, onChanged, onArchived }) {
  const [name, setName] = useState(space.name);
  const [members, setMembers] = useState([]);
  const [teams, setTeams] = useState(null);   // null = loading
  const [departments, setDepartments] = useState([]);
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback(() => {
    docketopsGet('getSpaceMembers', { space_id: space.id }, session).then(m => setMembers(m || [])).catch(() => {});
  }, [space.id, session]);
  useEffect(() => { loadMembers(); }, [loadMembers]);
  const fixedSolo = !!space.is_personal;   // P2: your personal space — only you, never shared or archived
  const loadTeams = useCallback(() => {
    if (space.is_founders || space.is_personal) { setTeams([]); return; }
    docketopsGet('getSpaceTeams', { space_id: space.id }, session).then(t => setTeams(t || []))
      .catch(e => { setTeams([]); showToast(planErrorText(e) || 'Could not load the teams', 'error'); });
  }, [space.id, space.is_founders, space.is_personal, session, showToast]);
  useEffect(() => { loadTeams(); }, [loadTeams]);
  useEffect(() => {
    if (space.is_founders || space.is_personal) return;
    docketopsGet('getDepartments', {}, session).then(d => setDepartments(d || [])).catch(() => {});
  }, [space.is_founders, space.is_personal, session]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members]);
  // Only employees with a login (auth_user_id) and not already a member can be added.
  const addable = useMemo(() => (employees || [])
    .filter(e => e.auth_user_id && !memberIds.has(e.auth_user_id))
    .map(e => ({ value: e.auth_user_id, label: e.full_name })), [employees, memberIds]);
  const teamList = teams || [];
  const teamIds = useMemo(() => new Set(teamList.map(t => t.department_id)), [teamList]);
  // A share covers the team's DIRECT members only (not its sub-teams), so the picker shows each team's live headcount.
  const headcount = useMemo(() => {
    const n = {}; (employees || []).forEach(e => { if (e.department_id) n[e.department_id] = (n[e.department_id] || 0) + 1; }); return n;
  }, [employees]);
  const addableTeams = useMemo(() => departments.filter(d => d.active !== false && !teamIds.has(d.id))
    .map(d => ({ value: d.id, label: `${d.name} · ${headcount[d.id] || 0} ${(headcount[d.id] || 0) === 1 ? 'person' : 'people'}` })), [departments, teamIds, headcount]);
  // People who also get in through a shared team: removing them from People doesn't remove their access.
  const viaTeam = useMemo(() => {
    const name = {}; teamList.forEach(t => { name[t.department_id] = t.name || 'a team'; });
    const m = {}; (employees || []).forEach(e => { if (e.auth_user_id && e.department_id && name[e.department_id]) m[e.auth_user_id] = name[e.department_id]; });
    return m;
  }, [teamList, employees]);
  // Non-owner members are the candidates for an ownership transfer.
  const transferable = useMemo(() => members.filter(m => !m.is_owner).map(m => ({ value: m.user_id, label: m.full_name || m.user_id })), [members]);

  async function call(action, body, okMsg) {
    if (busy) return;
    setBusy(true);
    try { await docketopsPost(action, body, session); if (okMsg) showToast(okMsg, 'success'); onChanged && onChanged(); return true; }
    catch (e) { showToast(planErrorText(e) || 'Failed', 'error'); return false; }   // founders_space (F9 R2)
    finally { setBusy(false); }
  }
  async function rename() { const n = name.trim(); if (!n || n === space.name) return; await call('renameSpace', { id: space.id, name: n }, 'Renamed'); }
  async function addMember(userId) { if (!userId) return; if (await call('addSpaceMember', { space_id: space.id, user_id: userId })) loadMembers(); }
  async function shareTeam(deptId) { if (!deptId) return; if (await call('shareSpaceWithTeam', { space_id: space.id, department_id: deptId })) loadTeams(); }
  async function unshareTeam(deptId) { if (await call('unshareSpaceTeam', { space_id: space.id, department_id: deptId })) loadTeams(); }
  async function removeMember(userId) {
    if (await call('removeSpaceMember', { space_id: space.id, user_id: userId })) {
      loadMembers();
      if (viaTeam[userId]) showToast(`Removed from People. They still have access through the ${viaTeam[userId]} team.`, 'info');
    }
  }
  async function transfer(userId) { if (!userId) return; if (await call('transferSpaceOwnership', { space_id: space.id, new_owner_user_id: userId }, 'Ownership transferred')) loadMembers(); }
  async function archive() {
    if (!window.confirm(`Archive "${space.name}"? It leaves the sidebar; tasks are kept.`)) return;
    if (await call('archiveSpace', { id: space.id })) onArchived && onArchived();
  }

  return (
    <div style={backdrop} data-modal onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>
        <div style={head}>
          <span style={title}><Lock size={14} style={{ color: 'var(--docket-accent)' }} /> Space settings</span>
          <button style={iconBtn} onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <label style={label}>Name</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename(); }} style={{ ...input, flex: 1 }} />
          <button className="dk-press" style={{ ...primaryBtn, opacity: name.trim() && name.trim() !== space.name ? 1 : 0.5 }} disabled={!name.trim() || name.trim() === space.name} onClick={rename}>Save</button>
        </div>

        {fixedSolo && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 14, lineHeight: 1.5 }}>
            Your personal space. Only you can see it, and it can't be shared or archived. Move your own work here;
            anything other people need to see belongs in a shared space.
          </div>
        )}
        {!space.is_founders && !fixedSolo && (
          <>
            <label style={{ ...label, marginTop: 16 }}>Shared with teams <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {teams ? teams.length : '…'}</span></label>
            <div style={memberList}>
              {teamList.map(t => (
                <div key={t.department_id} style={memberRow}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} style={{ color: 'var(--text-3)' }} />{t.name || 'Unknown team'}</span>
                  <button style={iconBtnSm} title="Stop sharing with this team" onClick={() => unshareTeam(t.department_id)}><Trash2 size={13} /></button>
                </div>
              ))}
              {teams === null && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
              {teams && teams.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Not shared with a team yet.</div>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 4 }}>
              Everyone directly in a shared team can see and work in this space. Sub-teams aren't included, so add them separately.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <Users size={13} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <Combobox value="" options={addableTeams} onChange={(v) => { if (v) shareTeam(v); }} placeholder="Share with a team…" allowClear={false} style={input} />
              </div>
            </div>
          </>
        )}

        {!fixedSolo && <>
        <label style={{ ...label, marginTop: 16 }}>People <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· {members.length}</span></label>
        <div style={memberList}>
          {members.map(m => (
            <div key={m.user_id} style={memberRow}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {m.is_owner && <Crown size={12} style={{ color: 'var(--docket-accent)' }} />}
                {m.full_name || m.user_id}
                {!m.is_owner && viaTeam[m.user_id] && <span style={{ fontSize: 10, color: 'var(--text-4)' }}>· also via {viaTeam[m.user_id]}</span>}
              </span>
              {!m.is_owner && <button style={iconBtnSm} title="Remove" onClick={() => removeMember(m.user_id)}><Trash2 size={13} /></button>}
            </div>
          ))}
          {members.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No members yet.</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <UserPlus size={13} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <Combobox value="" options={addable} onChange={(v) => { if (v) addMember(v); }} placeholder="Add a person…" allowClear={false} style={input} />
          </div>
        </div>

        </>}
        {!fixedSolo && transferable.length > 0 && (
          <>
            <label style={{ ...label, marginTop: 16 }}>Transfer ownership</label>
            <Combobox value="" options={transferable} onChange={(v) => transfer(v)} placeholder="Hand ownership to a member…" allowClear={false} style={input} />
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          {space.is_founders || fixedSolo ? <span /> : <button className="dk-press" style={dangerBtn} onClick={archive}><Trash2 size={13} /> Archive space</button>}
          <button className="dk-press" style={ghostBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', zIndex: 80 };
const card = { width: 440, maxWidth: '92vw', maxHeight: '84vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-lg)', padding: 18, boxShadow: '0 18px 50px rgba(0,0,0,0.5)' };
const head = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 };
const title = { display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-cond)', fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)' };
const label = { display: 'block', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 5 };
const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none', width: '100%' };
const memberList = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' };
const memberRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-1)', padding: '5px 8px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' };
const iconBtn = { display: 'inline-flex', background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2 };
const iconBtnSm = { display: 'inline-flex', background: 'transparent', border: 'none', color: 'var(--text-4)', cursor: 'pointer', padding: 2 };
const primaryBtn = { background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' };
const ghostBtn = { background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' };
const dangerBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid rgba(222,42,42,0.4)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' };
