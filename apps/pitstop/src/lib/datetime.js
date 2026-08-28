// Pitstop date/time formatting — always render in IST (Asia/Kolkata), since the
// CS team is in India and cs_tickets timestamps are full timestamptz.
//
// ⚠️ EVERY date/time a user reads goes through this file. Do not call `toLocaleDateString`
// / `toLocaleTimeString` / `toLocaleString` on a Date inline in a page — without an explicit
// `timeZone` they silently adopt whatever zone the renderer is in, and Next.js renders these
// pages on a UTC server before hydrating in the browser. A date-only format is the WORST
// case, not the mildest: any instant between 00:00 and 05:30 IST maps back to the previous
// calendar day, so the row reads a day early with no clock shown to give the error away.
// Swept 2026-08-21 (S302) across calls, inbox, queue/detail, new, admin/myop, CallPop,
// ShopifyPanel and ConversationPanel. (Number formatting via `toLocaleString('en-IN')` is
// unaffected and is fine inline — this rule is about instants only.)
const IST = 'Asia/Kolkata';

export function fmtIstDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return String(iso); }
}

export function fmtIstDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: '2-digit',
    });
  } catch { return String(iso); }
}

/** Day + month only — dense lists where the year is noise (`21 Aug`). */
export function fmtIstDayMonth(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short',
    });
  } catch { return String(iso); }
}

/** Day + month + clock, no year — conversation and call rows (`21 Aug, 02:18 pm`). */
export function fmtIstShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return String(iso); }
}

/** Full date with a four-digit year — panels and detail fields (`21 Aug 2026`). */
export function fmtIstDateLong(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch { return String(iso); }
}

/** Full date + clock with a four-digit year — audit trails (`21 Aug 2026, 02:18 pm`). */
export function fmtIstStamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return String(iso); }
}
