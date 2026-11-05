'use client';
import { useEffect, useState } from 'react';
import { ignitionopsGet } from '../lib/ignitionopsFetch.js';

// Owner dropdown (#5, Reann #11): the influencer team member taking the collab forward.
// Source = getIgnitionUsers. Reports both poc_user_id and poc_name up via
// onChange({ poc_user_id, poc_name }). `currentName` keeps an owner who has since left the team
// showing on a deal that already has them, rather than reading as unset.
export default function PocSelect({ value, onChange, session, style, currentName, disabled }) {
  const [users, setUsers] = useState([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getIgnitionUsers', {}, session)
      .then(r => { setUsers(r.users || []); setFailed(false); })
      .catch(() => { setUsers([]); setFailed(true); });
  }, [session]);

  // The owner is required, so an empty list must say why it is empty rather than just blocking the form.
  return (
    <>
    <select
      value={value || ''}
      onChange={e => {
        const id = e.target.value;
        const u = users.find(x => x.id === id);
        onChange({ poc_user_id: id || null, poc_name: u ? u.full_name : null });
      }}
      style={style}
      disabled={disabled}
    >
      <option value="" disabled>— pick an owner —</option>
      {value && currentName && !users.some(u => u.id === value) && <option value={value}>{currentName}</option>}
      {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
    </select>
    {failed && <span style={{ display: 'block', fontSize: 12, color: 'var(--state-error-fg)', marginTop: 4 }}>Could not load the team. Refresh the page to try again.</span>}
    </>
  );
}
