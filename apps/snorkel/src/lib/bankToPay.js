// Which of a payee's bank accounts Finance pays a request into. No React import on purpose, so a
// plain node:test file in snorkelops-worker/test can import it (as requesterNote.js / tds.js).
//
// A request may PIN an account (`payment_requests.payee_bank_id` — set by ignitionRaisePayment to
// the creator's account copied from Ignition). A pinned request is paid into that account only:
// when it is not among the payee's ACTIVE accounts (deactivated, or another payee's), the answer is
// no bank plus `pinnedMissing`, so the screen warns instead of quietly showing the default account.
// An unpinned request keeps the old behaviour: the default account (the list is default-first).
//
//   bankToPay(banks, request) → { bank: row | null, pinned: boolean, pinnedMissing: boolean }
export function bankToPay(banks, request) {
  const list = Array.isArray(banks) ? banks : [];
  const pin = request?.payee_bank_id;
  if (pin == null || pin === '') return { bank: list[0] || null, pinned: false, pinnedMissing: false };
  const hit = list.find(b => b && String(b.id) === String(pin)) || null;
  return { bank: hit, pinned: true, pinnedMissing: !hit };
}
