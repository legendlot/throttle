# Changelog - Pitstop Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.14.0] - 2026-08-28
### Added
- **Post Comments** — a new chapter for the new Comments screen. Covers the ten-minute sync (and
  why a quiet screen may just be a few minutes behind), Sync now, claiming and replying, and the
  fact that a reply posts publicly under the L.O.T account rather than the agent's own.
- Spells out the two distinctions the screen most invites people to get wrong: **Done** is about
  your work and changes nothing on Instagram, while **Hide** removes the comment from public view;
  and **Delete** is permanent, admin only, and should lose to Hide almost every time.
- States plainly that Facebook Page comments are **not** included yet (the permission is not
  granted), so nobody assumes this screen covers both networks.

## [1.13.0] - 2026-08-28
### Changed
- **BiteSpeed is gone from the manual, because it is gone from the product.** The ticket screen no
  longer shows a read-only WhatsApp mirror with a "Reply in BiteSpeed" button: it shows the
  customer's conversation on whichever channel raised the ticket (WhatsApp, Instagram, Messenger,
  email or web chat) with an **Open in inbox** button that opens that exact conversation. Rewrote
  the "Where the conversation happens" callout in the Introduction and the conversation callout in
  Work a Ticket to match.
- The Introduction said phone calls arrive from MyOperator. They have come from **Exotel** since
  19 August; corrected in the same pass.

### Added
- Work a Ticket: a **Linked or just matched** warning. When no conversation is bound to the ticket
  the panel falls back to matching the customer by phone or email, and the manual now says plainly
  that a match is background rather than a binding, and how to bind one.

## [1.11.0] - 2026-08-27
### Added
- The Inbox: chats can now arrive in **Mine** without being claimed. Explains the retro-assignment
  sweep in the agent's terms — small batches, last 7 days only, Release/Transfer if it is not
  yours — and why it exists (a chat with a name on it gets answered; a shared pile does not).
- The Inbox: a third health banner, **"Outgoing messages: sending is down"**, distinct from the
  per-channel ones because it means nothing is leaving at all. Tells agents the two things that
  actually mattered during the 27 Aug outage: incoming is safe, and retyping a failed reply will
  not help.

## [1.10.0] - 2026-08-27
### Added
- Meta Diagnostics (`/admin/meta`): a new admin chapter for the screen that lists refused
  Instagram/Messenger sends and probes a chat to find out why. Documents the four error codes
  actually observed on this estate (10 / 100 / 190 / 200), how to read the probe's `me` vs
  `recipient` result, and that Diagnose sends nothing.
- Carries the standing warning that the raw Meta error must not be translated into an
  explanation: in August 2026 an error was paraphrased from documentation rather than measured,
  and the resulting copy told agents a reply would send while it was silently failing.

### Note
- `manual.json` was already at **1.9.0** with no matching entry in this file — the version was
  bumped by the S317 lane alongside the Closure Requests queue tab and the business-hours
  default, and the changelog step was missed. Recorded here rather than renumbered, since the
  PDF for that version has already been built and this file's own rule is that the version on
  the cover must match. 1.9.0's content is that lane's to describe.

## [1.8.0] - 2026-08-26
### Added
- The Inbox: new "If a whole channel goes quiet" section for the channel-health banner.
  Explains what the red banner means, why it cannot be dismissed (it clears itself when
  replies resume), and what to do first. Names the August 2026 Instagram outage as the
  case it exists for, and the reason it is easy to miss: automatic messages kept flowing
  the whole time, so the channel looked healthy from outside while agent replies failed.
  States honestly that it is checked four times a day, so it confirms a problem rather
  than being the first warning.
- The Inbox: message-length callout. Instagram and Messenger stop at 2,000 characters,
  WhatsApp at 4,096; a counter appears as you approach and Send greys out past the limit.
  Notes that before this existed the send just failed silently, which is what agents were
  hitting when a long reply had to be retried.
- The Inbox: inbound email attachments are kept for six months and then removed, after
  which the chip says so. Every original stays on the email in Gmail.

## [1.7.0] - 2026-08-24
> Reconstructed 2026-08-26 (S314) from commit `302cd965`: `manual.json` was bumped to 1.7.0
> but no entry was written here, so the file skipped from 1.6.0 to 1.8.0. Contents below are
> taken from that commit's own description, not re-derived from the chapters.
### Added
- Calls: softphone chapter (`work-calls`).
- Reports: Resolution metric-change warning and the Agents tab (`analyze-reports`), including
  the corrected export callout.
- Telephony: setup button (`admin-telephony`).

## [1.6.0] - 2026-08-21
### Added
- The Inbox: new "Alerts: badge, chime and desktop notifications" section. What
  each of the three alerts is for and why they are different - the badge only
  helps if you can see the tab, the chime only if your sound is on, and the
  desktop notification is the one that reaches an agent when Pitstop is behind
  another window. Covers allowing the browser permission, what to do when the
  button shows red or is greyed out, why repeats from one customer collapse into
  a single notification, and that alerts follow whichever list (Mine / All) is
  on screen.
- The Inbox: new "Keyboard" section - arrow keys move the highlight, Enter opens,
  and typing a reply is never interrupted.
- The Inbox: warning callout for the "showing a mirrored copy" banner, telling
  agents not to assume the last visible message is the last one sent.
- New Ticket: the Category filter above Product, including that it is only a
  finding aid and is never stored on the ticket.

## [1.5.0] - 2026-08-20
### Added
- Telephony (/admin/telephony): new chapter. Who can place calls from Pitstop
  and which phone rings first, how a call actually goes out (we ring the agent,
  then the customer, on the Legend of Toys number), the mobile fallback when a
  SIP device is not registered, and why an accurate mobile number matters for
  attribution.

### Changed
- Calls: six KPI cards, not five (Abandoned added). New Abandoned and Needs
  callback tabs. New section explaining the Talk column, conversation time with
  line-open time after a slash. New "Calling someone back" section for the Call
  button. Row menu now documents the one-press "Nothing needed - close" with
  Undo. New callout on why every call gets a ticket, including very short ones.
- Calls: warning that Missed and Abandoned are different things and that calls
  before 20 August 2026 do not have the split, so historic Missed counts read
  far lower than reality. Comparisons across that date will look like a
  regression when they are a correction.
- Call Detail: recordings now play. Replaced the old "a recording may lag" note,
  which described a link that in fact never worked, with how to use the player,
  the one-hour link expiry, and an honest note that pre-20-August calls cannot be
  played because the old system only ever sent a file name.
- MyOperator Accounts: documented the Exotel panel now at the top of that page,
  the health line and the backfill, plus why the MyOperator accounts are kept
  rather than deleted.

## [1.4.0] - 2026-06-27
### Changed
- The Inbox: added email as a fourth channel throughout (lead, channel tabs).
  Documented the email composer header fields, To and Subject (pre-filled,
  editable) plus the + Cc / Bcc expander, comma-separated addresses. WhatsApp
  note now states the full chat history scrolls back, not just recent messages.
- The Queue: documented Prev / Next pagination (50 per tab; resets to page 1
  when the tab, a filter or the search changes).
- Calls: added the Open and Closed tabs (calls whose linked ticket is still
  being worked or has been resolved) to the tab list.
- Working a Ticket: new "Switching between Replacement and Refund" section, the
  reversible disposition switch any agent can make before the resolution starts,
  with the in-motion lock callout.

## [1.3.0] - 2026-06-25
### Changed
- The Inbox: WhatsApp is now two-way. Agents reply to WhatsApp from Pitstop;
  the customer's messages are pulled in live (both sides visible). Free-text
  works inside the 24-hour window; the composer is disabled once it closes
  (templates to reopen are a fast-follow). Replaced the old "read-only mirror"
  note. WhatsApp attachments not supported yet.
- The Inbox: new Transfer action (pick an agent, add an optional note, the chat
  moves to their queue with the note). Agents can transfer their own /
  unassigned chats; leads and admins can transfer any chat.
- The Inbox: replying to a customer now also assigns the linked ticket to the
  replier (whoever answers owns the case).
- Navigation: the sidebar is now collapsible (collapsed by default) via the
  bottom chevron or the PITSTOP header; added Inbox + Overview to the Work menu.

## [1.2.1] - 2026-06-23
### Changed
- The Inbox: documented multi-select + bulk assign (tick rows or Select-all,
  then Assign to… / Me / another agent / Release in one action).
- Calls: documented the new Prev / Next pagination (50 per page) for browsing
  older call records.

## [1.2.0] - 2026-06-23
### Added
- New chapter **The Inbox** (Work part): the cross-channel conversations console
  (Instagram, Messenger, WhatsApp). Covers the channel / Mine-Unassigned-All /
  Active-Closed layout, setting conversation **Priority** (Urgent / High / Normal /
  Low), **filtering and sorting** the list (by recent / oldest / priority, and by
  priority, tag or assigned agent), tagging and assigning, replying with the emoji /
  canned-response / attachment composer and private notes, the 24-hour reply window,
  WhatsApp being read-only for now, and **linking or creating a ticket** from a chat.

## [1.1.0] - 2026-06-15
### Changed
- Departments: now also where you set a teammate's CS role. Documented the new
  **Set Role** dropdown (Viewer / Agent / Team Lead), the rule that only CS roles are
  set here (wider company roles show as "Garage-managed"), and that you cannot change
  your own role. "Who" updated to Lead + Admin (Team Leads can open this screen).
- Departments: a person can now belong to **multiple departments** (tick boxes) and
  sees the tickets and calls of all of them; replaces the single-department dropdown.
- New Ticket: product, model and colour are now cascading **dropdowns** that auto-fill
  the SKU, as an alternative to the UPC lookup.

## [1.0.1] - 2026-06-06
### Changed
- Content freshness pass for changes since 1.0.0:
  - The Queue: ticket creation date and time (Indian time) now shown under the Age column.
  - Working a Ticket: header shows product colour and creation time; Shopify panel now
    carries full order details (line items, totals, shipping address, courier tracking).
  - Working a Ticket: verifying the issue requires an evidence attachment first — the
    Advance step now spells this out.
  - Calls: repeat calls from the same customer coalesce into the existing open ticket
    instead of spawning duplicates (every call still logged).

## [1.0.0] - 2026-05-29
### Added
- Complete self-serve manual for Pitstop: 4 parts, 12 chapters (Getting Started,
  Work, Analyze, Admin) covering the queue, the ticket workspace, new tickets,
  calls, reports and the three admin screens. Role-segmented (Agent / Lead /
  Admin). Built with the shared pipeline and the impeccable-polished theme; copy
  in house style (no em dashes).
