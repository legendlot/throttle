'use client';
// New program (ClickUp redesign P2): opened from the top-bar "+ New" menu and the
// sidebar Programs header "+". Name only — Docket has no program colour palette
// (programs without a stored colour fall back to personColor(id) everywhere).
// `createProgram` is idempotent on a case-insensitive name: an existing program's
// name returns that program, so "duplicate" lands you on it rather than erroring.
import { useEffect, useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { docketopsPost } from '../lib/docketopsFetch.js';
import { Button } from './ui/index.js';

export function NewProgramModal({ session, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function create() {
    const n = name.trim(); if (!n || saving) return;
    setSaving(true); setError('');
    try {
      const prog = await docketopsPost('createProgram', { name: n }, session);
      if (!prog?.id) throw new Error('Program was not created');
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed'));
      onCreated(prog);
    } catch (e) {
      console.error('createProgram failed', e);
      setError("Couldn't create the program — try again");
      setSaving(false);
    }
  }
  // Keep Tab inside the dialog.
  function trap(e) {
    if (e.key !== 'Tab') return;
    const els = Array.from(boxRef.current?.querySelectorAll('input, button:not([disabled])') || []);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  return (
    <div className="backdrop dk-modal-backdrop" style={{ alignItems: 'flex-start', justifyContent: 'center' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} className="dk-modal" role="dialog" aria-modal="true" aria-labelledby="dk-np-title" onKeyDown={trap} onMouseDown={e => e.stopPropagation()}>
        <div className="dk-modal-title" id="dk-np-title"><Flag size={14} aria-hidden /> New program</div>
        <p className="dk-modal-sub">A program groups tasks across spaces. You'll see it in the sidebar once a task you can see is tagged to it.</p>
        <input autoFocus className="dk-modal-input" value={name} onChange={e => { setName(e.target.value); setError(''); }}
          placeholder="Program name (e.g. Diwali launch)" aria-invalid={!!error || undefined}
          onKeyDown={e => { if (e.key === 'Enter') create(); }} />
        {error && <div className="dk-modal-err" role="alert">{error}</div>}
        <div className="dk-modal-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={saving} onClick={create}>Create program</Button>
        </div>
      </div>
    </div>
  );
}

export default NewProgramModal;
