'use client';
import { useEffect, useState } from 'react';
import { ignitionopsGet } from '../lib/ignitionopsFetch.js';

// POC dropdown (#5) — the Ignition team member taking the collab forward.
// Source = getIgnitionUsers. Reports both poc_user_id and poc_name up via
// onChange({ poc_user_id, poc_name }).
export default function PocSelect({ value, onChange, session, style }) {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getIgnitionUsers', {}, session)
      .then(r => setUsers(r.users || []))
      .catch(() => setUsers([]));
  }, [session]);

  return (
    <select
      value={value || ''}
      onChange={e => {
        const id = e.target.value;
        const u = users.find(x => x.id === id);
        onChange({ poc_user_id: id || null, poc_name: u ? u.full_name : null });
      }}
      style={style}
    >
      <option value="">— unassigned —</option>
      {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
    </select>
  );
}
