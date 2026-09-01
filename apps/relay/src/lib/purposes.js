// The purpose vocabulary for the Relay UI — the frontend mirror of
// `commsops-worker/src/purposes.js`, which is the authority. Keep the two in step.
//
// WHY THIS FILE EXISTS. The list used to be a hardcoded literal in FOUR page files
// (`templates`, `campaigns`, `contacts`, `segments`), all reading
// `['marketing','transactional','utility']`. It went stale twice without anyone noticing —
// `service` (S274) and `influencer_outreach` (S327) were both added to the send path and to
// neither dropdown. The API accepts any purpose, so the only consequence was that a HUMAN
// could not author one: it took a Claude/SQL write, which is exactly the self-serve gap this
// app exists to close. A named module is the thing that makes the next addition a one-line
// edit instead of a silent drift.
//
// ⚠️ NOT EVERY DROPDOWN SHOULD USE THIS LIST, and that is deliberate — see below. Importing it
// blindly into all four is how you ship dead UI.

// Every purpose the send path accepts. Mirrors commsops `PURPOSES`, same order.
export const PURPOSES = ['marketing', 'influencer_outreach', 'service', 'utility', 'transactional'];

// Human-facing labels — `influencer_outreach` reads badly raw in a select.
export const PURPOSE_LABELS = {
  marketing: 'marketing',
  influencer_outreach: 'influencer outreach',
  service: 'service',
  utility: 'utility',
  transactional: 'transactional',
};

export const purposeLabel = (p) => PURPOSE_LABELS[p] || p;

// ── Where this list belongs, and where it does NOT ───────────────────────────────
//
// ✅ `templates` — the AUTHORING axis. A template may carry any purpose the send path accepts,
//    so both the editor select and the library filter use the full list. This is the one that
//    unblocks a person.
//
// ⛔ `contacts` / `segments` — these are CONSENT-axis filters, not authoring. They filter
//    `comms.consent.purpose`, and that column has only ever held two values:
//    measured 2026-09-01 — marketing 300,032 · transactional 90,999, nothing else, ever.
//    Adding a purpose here yields a filter that always returns nobody. (`utility` is already
//    exactly that dead option today, inherited from the old literal — removing it is a
//    behaviour change, so it is filed in BACKLOG rather than done in passing.)
//    If consent ever starts recording another purpose, filter on what `comms.consent` actually
//    holds — do NOT import PURPOSES here.
//
// ⛔ `campaigns` — the send path now accepts an outreach campaign (approval + budget pre-flight
//    landed S327), but no one has designed that authoring flow. Offering the option in the
//    dropdown would promise a flow that does not exist. Add it WITH the flow, not before.
