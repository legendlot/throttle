// Human labels for the machine identifiers the journey engine works in.
//
// Step ids, step types and branch outcomes are all engine-side strings —
// `pay_convert`, `wait_response`, `no_reply`. They are the right names in the
// graph JSON and in the worker, and the wrong ones on a screen a CS lead reads:
// the Funnel panel was rendering rows like `pay_wait · wait_respo…` and calling
// that a report. This is the single place that turns them into English, shared
// by the Funnel list and the canvas node outcomes so the two can never drift.
//
// Deliberately a MAPPING PLUS a fallback, not a clever parser. Known ids get a
// phrase written for a human; anything unknown de-snake-cases and sentence-cases,
// which is always readable and never wrong. A journey author can invent any step
// id they like, so the fallback is the common path, not the exception.

const STEP_TYPE_LABEL = {
  send: 'Send',
  wait: 'Wait',
  wait_response: 'Wait for reply',
  condition: 'Condition',
  exit: 'Exit',
  action: 'Action',
};

// Outcomes are the branch handles a step can leave by. These are the ones the
// engine emits; anything else falls through to the de-snake-cased form.
const OUTCOME_LABEL = {
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  responded: 'Replied',
  no_reply: 'No reply',
  noreply: 'No reply',
  timeout: 'No reply in time',
  expired: 'Window expired',
  done: 'Done',
  not_done: 'Could not complete',
  notdone: 'Could not complete',
  next: 'Continued',
  branch_true: 'Yes',
  branch_false: 'No',
  completed: 'Completed',
  exited: 'Exited',
  entered: 'Entered',
  yes_cancel: 'Chose to cancel',
  no_keep: 'Chose to keep',
};

// Fragments that read badly when naively title-cased, so they are expanded first.
const WORD = {
  msg: 'message', pay: 'payment', convert: 'conversion', tag: 'tag',
  ask: 'ask', cancel: 'cancel', confirm: 'confirm', noresp: 'no-response',
  stuck: 'stuck', link: 'link', wait: 'wait', done: 'done', unpaid: 'unpaid',
};

function sentenceCase(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// `pay_notdone_msg` → `Payment could-not-complete message`-ish. The goal is a
// phrase someone can act on, not a perfect translation.
export function humanStepId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '—';
  const words = raw.split(/[_\-.]+/).filter(Boolean).map((w) => WORD[w.toLowerCase()] || w);
  return sentenceCase(words.join(' '));
}

export function humanStepType(type) {
  const raw = String(type || '').trim();
  if (!raw) return '';
  return STEP_TYPE_LABEL[raw] || sentenceCase(raw.replace(/[_\-]+/g, ' '));
}

export function humanOutcome(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  // `exit:<name>` is a compound the engine builds — keep the destination visible.
  if (raw.startsWith('exit:')) return `Exit → ${humanStepId(raw.slice(5))}`;
  const hit = OUTCOME_LABEL[raw.toLowerCase()];
  if (hit) return hit;
  return sentenceCase(raw.replace(/^branch_/, '').replace(/[_\-]+/g, ' '));
}

// Enrolment statuses on the Funnel's summary chips.
const ENROLMENT_LABEL = {
  active: 'In flight', completed: 'Completed', exited: 'Exited',
  failed: 'Failed', unpaid: 'Unpaid', no_response: 'No response',
  send_failed: 'Send failed',
};
export function humanEnrolmentStatus(key) {
  const raw = String(key || '').trim();
  return ENROLMENT_LABEL[raw.toLowerCase()] || sentenceCase(raw.replace(/[_\-]+/g, ' '));
}
