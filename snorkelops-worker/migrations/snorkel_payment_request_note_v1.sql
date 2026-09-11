-- snorkel_payment_request_note_v1 (2026-09-11): "Note for Finance" on payment requests.
-- Free text the requester passes to Finance — typically the payee's bank details, which the
-- procurement team sources and used to share separately on Slack (Siddu, #bugs 1789042876.535959).
-- ⚠️ PLAIN TEXT, NOT MASKED, and deliberately NOT a payment_payee_banks row (Afshaan, 2026-09-11):
-- the team sourcing the details sees them anyway. It lives on the REQUEST, not the payee.
-- No CHECK: the 2000-char cap and the trim/''→NULL rule are enforced by snorkelops
-- (parseRequesterNote), the only writer of this table.
alter table store.payment_requests
  add column if not exists requester_note text;

notify pgrst, 'reload schema';
