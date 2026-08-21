// Desktop notifications for Pitstop.
//
// The point of these is the BACKGROUNDED tab. An agent with Pitstop behind their browser, or
// behind another app entirely, currently gets a tab-title badge they cannot see and a chime that
// may be muted or blocked. A desktop notification is the only channel that reaches them there.
//
// ⚠️ Every entry point is fully wrapped and fails silently. A notification is a courtesy, never
// load-bearing: it must never throw into a poll loop or break a render. Same posture as `chime()`
// in the inbox, and for the same reason — this fires from inside a setInterval that also drives
// the thread list.
//
// ⚠️ Permission is requested ONLY from a user gesture (the toggle). Browsers ignore or
// auto-deny `requestPermission()` called on page load, and Chrome permanently blocks an origin
// that asks without interaction — asking at the wrong moment can cost the capability for good.

const LS_KEY = 'pitstop_desktop_notifications';

/** Does this browser support notifications at all? (Safari on iOS does not.) */
export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notifyPermission() {
  if (!notifySupported()) return 'unsupported';
  try { return Notification.permission; } catch { return 'unsupported'; }
}

/** The agent's own on/off choice, remembered per browser. Independent of the OS permission. */
export function notifyEnabled() {
  if (!notifySupported()) return false;
  try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
}

export function setNotifyEnabled(on) {
  try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * Ask for permission. Call ONLY from a click handler.
 * Returns the resulting permission string.
 */
export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  try {
    // Safari <16 uses the callback form and returns undefined from the promise form.
    const r = await Notification.requestPermission();
    return r || Notification.permission;
  } catch { return notifyPermission(); }
}

/**
 * Show one notification.
 *
 * `tag` collapses repeats: two messages from the same conversation replace each other rather
 * than stacking, so an agent who steps away for ten minutes returns to one notification per
 * conversation instead of forty. This is the single most important option here — without it a
 * busy queue turns into a notification storm and the agent switches the feature off.
 *
 * `onClick` runs after focusing the window, so the caller can route to the conversation.
 */
export function notify(title, { body, tag, onClick, requireInteraction = false } = {}) {
  if (!notifySupported() || !notifyEnabled()) return null;
  if (notifyPermission() !== 'granted') return null;
  // Don't interrupt an agent who is already looking at the page — the in-app UI already told
  // them. Notifications are for the tab they cannot see.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return null;
  try {
    const n = new Notification(title, {
      body: body || undefined,
      tag: tag || undefined,
      icon: '/favicon.png',
      renotify: false,
      requireInteraction,
    });
    n.onclick = () => {
      try { window.focus(); } catch {}
      try { onClick?.(); } catch {}
      try { n.close(); } catch {}
    };
    return n;
  } catch {
    // Some browsers throw on construction inside an insecure context or when the OS is in
    // do-not-disturb. Swallow it — the badge and chime still do their work.
    return null;
  }
}

/** Trim a message body to something that reads as a preview, not a wall. */
export function previewText(s, max = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
