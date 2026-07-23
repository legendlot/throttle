'use client';
// ⌘K "New …" deep-link consumer, shared by campaigns/journeys/segments/templates.
//
// Two delivery paths (hostile-review fix, S231):
// - CROSS-SCREEN: the palette pushes `/<screen>?new=1`; the page mounts, consumes
//   the param once, cleans the URL (so a later hard refresh doesn't unexpectedly
//   reopen a blank form), then opens the form.
// - SAME-SCREEN: an App Router push that only changes the query string does NOT
//   remount the page, so a mount-only effect never fires. The palette instead
//   dispatches a `relay:new` window event when the user is already on the target
//   screen; pages subscribe here.
//
// `enabled` carries the page's build/edit permission — a viewer-only user
// (hand-typed URL or leaked event) never has the form opened for them; the
// param is still cleaned so the landmine is defused either way.
import { useEffect, useRef } from 'react';

export function useNewParam(enabled, onNew) {
  const cb = useRef(onNew);
  cb.current = onNew;
  const consumed = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!consumed.current && new URLSearchParams(window.location.search).get('new') === '1') {
      consumed.current = true;
      window.history.replaceState(null, '', window.location.pathname);
      if (enabled) cb.current();
    }
    const h = () => { if (enabled) cb.current(); };
    window.addEventListener('relay:new', h);
    return () => window.removeEventListener('relay:new', h);
  }, [enabled]);
}
