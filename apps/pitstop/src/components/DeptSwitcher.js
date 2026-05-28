'use client';
import { useEffect, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { csopsGet } from '../lib/csopsFetch.js';

const STORAGE_KEY = 'pitstop.dept';

export function getActiveDept(perms, ownSlug) {
  // Admins read the override from localStorage. Non-admins are locked to own dept.
  if (perms?.cs_ticket_admin) {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(STORAGE_KEY) || null; // null = "all"
  }
  return ownSlug || null;
}

export function setActiveDept(slug) {
  if (typeof window === 'undefined') return;
  if (!slug) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, slug);
  window.dispatchEvent(new CustomEvent('pitstop:dept-changed', { detail: { slug } }));
}

export default function DeptSwitcher() {
  const { brandUser, perms, session } = useAuth();
  const isAdmin = !!perms?.cs_ticket_admin;
  const ownSlug = brandUser?.cs_department_slug || null;
  const ownName = brandUser?.cs_department_name || null;

  const [open, setOpen] = useState(false);
  const [depts, setDepts] = useState([]);
  const [activeSlug, setActiveSlugState] = useState(() => getActiveDept(perms, ownSlug));

  useEffect(() => {
    if (!session) return;
    csopsGet('getDepartments', {}, session).then(setDepts).catch(() => setDepts([]));
  }, [session]);

  useEffect(() => {
    // Re-read the active slug if perms shape settles after first paint
    setActiveSlugState(getActiveDept(perms, ownSlug));
  }, [perms, ownSlug]);

  const labelDept = activeSlug
    ? (depts.find(d => d.slug === activeSlug)?.name || activeSlug)
    : (isAdmin ? 'All Departments' : (ownName || 'No Department'));

  function pick(slug) {
    if (!isAdmin) return;
    setActiveDept(slug);
    setActiveSlugState(slug);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => isAdmin && setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-1)',
          borderRadius: 6,
          color: 'var(--t1)',
          fontSize: 12, fontWeight: 600,
          cursor: isAdmin ? 'pointer' : 'default',
        }}
        title={isAdmin ? 'Switch department (admin)' : 'Locked to your department'}
      >
        <Building2 size={13} style={{ color: 'var(--t3)' }} />
        {labelDept}
        {isAdmin && <ChevronDown size={12} style={{ color: 'var(--t3)' }} />}
      </button>

      {open && isAdmin && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 100,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-1)',
          borderRadius: 6,
          minWidth: 200,
          padding: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
          <DeptItem label="All Departments" active={!activeSlug} onClick={() => pick(null)} />
          <div style={{ borderTop: '1px solid var(--border-1)', margin: '4px 0' }} />
          {depts.map(d => (
            <DeptItem key={d.id} label={d.name} active={activeSlug === d.slug} onClick={() => pick(d.slug)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeptItem({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 10px', width: '100%',
        background: active ? 'var(--surface-2)' : 'transparent',
        border: 'none', borderRadius: 4,
        color: 'var(--t1)', fontSize: 13, fontWeight: 500,
        cursor: 'pointer', textAlign: 'left',
      }}
    >
      <Check size={12} style={{ visibility: active ? 'visible' : 'hidden', color: 'var(--accent)' }} />
      {label}
    </button>
  );
}
