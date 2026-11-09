'use client';
// TaskView layout preference + the hand-off between the overlay modes (modal / side,
// drawn over the list) and full-page mode (/tasks/detail/?id=…).
//
// localStorage `docket.taskView.mode` — 'modal' (default, D3) | 'side' | 'full', per
// person per device. sessionStorage carries, across the route change to full page,
// where to go back to (`docket.taskView.return`) and the ‹ › order of the list the
// task was opened from (`docket.taskView.order`).
export const MODES = ['modal', 'side', 'full'];
const MODE_KEY = 'docket.taskView.mode';
const RETURN_KEY = 'docket.taskView.return';
const ORDER_KEY = 'docket.taskView.order';
const VIA_KEY = 'docket.taskView.via';   // the id goFull is navigating to

export function readMode() {
  try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : 'modal'; } catch { return 'modal'; }
}
export function writeMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } }

// The current URL minus any `task` param (the overlay deep link), so "back" lands on
// the list itself.
function currentListUrl() {
  const u = new URL(window.location.href);
  u.searchParams.delete('task');
  return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
}

// Overlay → full page. Remembers the list URL + its order for ‹ › and "back".
// From a `?task=` deep link the overlay URL is replaced, not stacked, so Back from the
// full page doesn't land on a URL that reopens the task.
export function goFull(router, id, order) {
  try {
    sessionStorage.setItem(RETURN_KEY, currentListUrl());
    sessionStorage.setItem(ORDER_KEY, JSON.stringify(Array.isArray(order) ? order : []));
    sessionStorage.setItem(VIA_KEY, id);
  } catch { /* ignore */ }
  const fromLink = new URL(window.location.href).searchParams.has('task');
  const url = `/tasks/detail/?id=${id}`;
  if (fromLink) router.replace(url); else router.push(url);
}

// Called once when the full page mounts: unless goFull brought us here, forget any
// return URL / order left from an earlier visit (× then falls back to /tasks).
export function claimFull(id) {
  try {
    if (sessionStorage.getItem(VIA_KEY) !== id) { sessionStorage.removeItem(RETURN_KEY); sessionStorage.removeItem(ORDER_KEY); }
    sessionStorage.removeItem(VIA_KEY);
  } catch { /* ignore */ }
}

export function readReturn() {
  try { return sessionStorage.getItem(RETURN_KEY) || '/tasks'; } catch { return '/tasks'; }
}
export function readOrder() {
  try { const o = JSON.parse(sessionStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(o) ? o : []; } catch { return []; }
}

// Full page → overlay: back to the list it came from, with the task reopened there
// (`?task=` is read by the tasks page). Other origins (checklist) just go back.
export function leaveFull(router, id) {
  const ret = readReturn();
  const u = new URL(ret, window.location.origin);
  if (id && /^\/tasks\/?$/.test(u.pathname)) u.searchParams.set('task', id);
  router.push(u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : ''));
}

// Visible task order on the current screen, top to bottom — list rows (The Grid,
// groups, Archived) or board cards column by column (the board's DOM is column-major).
export function domTaskOrder() {
  if (typeof document === 'undefined') return [];
  const ids = [];
  document.querySelectorAll('.tl-row[data-task-id], .gcard[data-nav-id], .archived-row[data-nav-id], .kb-card[data-card-id]').forEach(el => {
    const id = el.getAttribute('data-task-id') || el.getAttribute('data-nav-id') || el.getAttribute('data-card-id');
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}
