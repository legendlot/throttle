# Podium J1 — Podium creates the work account, then confirms joining

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` → "J1" (v4.1). The Google write SA is live
(`GOOGLE_ADMIN_SA_JSON`, `googleWriteToken(env, 'directory')`, verified by `getGoogleWriteCheck`, 2026-11-11).

## Shape (two human actions, not one)

1. **Create work account** — an application is `accepted` with its latest offer `accepted`. A Google admin
   (allow-list below) picks the address and OU → Podium creates the Google user. Temp password shown ONCE.
   No employee row yet.
2. **Confirm joining** — on the day the person turns up, HR enters the actual start date → ONE atomic DB function
   creates the employee, copies the hiring documents, writes the `initial` compensation event, marks the
   application `joined` and the opening `filled` when its headcount is reached.
3. **No-show** — application → `no_show`; if an account was created, the card offers **Suspend account** (Google
   write, logged). Nothing else suspends anything.

Why two steps: an employee row created before the start date with a no-show afterwards would leave a phantom in
the SG&A/payroll feeds (`date_joined` gates them). The auth link needs no help: `podium.link_auth_on_employee_write`
links `auth_user_id` by `work_email` when the employee row is inserted, and `link_employee_on_auth_insert` links it
if the person signs in later.

**Out of scope (say so in the UI, don't build):** rehire. If `candidates.employee_id` is set (an earlier employee),
both actions refuse with `rehire_not_supported_yet` — a rehire needs X1's employment periods, else overwriting
`date_joined` destroys the earlier employment in the cost feeds. J1b field sync, X1 exits, J2 onboarding: later.

## Migration `podiumops-worker/migrations/0009_work_accounts.sql` (lane applies it as `podium_work_accounts_v1`)

- `podium.google_admin_access (auth_user_id uuid pk, added_by uuid, note text, added_at timestamptz default now())`
  — the per-PERSON allow-list (L3). NOT a role: the Podium `admin` role is also held by someone outside L3.
  Seed in the migration: `insert … select e.auth_user_id from podium.employees e where e.work_email in
  ('afshaan@legendoftoys.com','vinay@legendoftoys.com','mohit@legendoftoys.com') and e.auth_user_id is not null
  on conflict do nothing` (all three have auth ids, checked 2026-11-11). Service-role only, RLS on, no policies (same as comp_access).
- `podium.work_accounts`:
  `id uuid pk default gen_random_uuid()`, `application_id uuid unique references podium.applications`,
  (null only for an override), `candidate_id uuid`, `email text not null` (lowercased), `given_name text not null`,
  `family_name text not null`, `org_unit_path text not null`, `status text not null check in
  ('pending','created','failed','suspended')`, `google_user_id text`, `employee_id uuid` (allocated on the first
  confirm attempt, reused on retry), `override_reason text`, `last_error text`, `requested_by uuid not null`,
  `created_at`, `updated_at`, `suspended_at`, `suspended_by`.
  - unique index on `lower(email)` where status <> 'failed'.
  - check: `application_id is not null or length(btrim(override_reason)) >= 10`.
- `podium.google_admin_log`: `id`, `actor uuid not null`, `actor_email text`, `action text not null check in
  ('create_user','link_existing','suspend_user')`, `target_email text not null`, `google_user_id text`,
  `work_account_id uuid`, `request jsonb` (NEVER the password), `ok bool not null`, `error text`, `created_at`.
  Append-only: reuse `podium.refuse_event_mutation()` as an update/delete trigger.
- RPC `podium.hiring_confirm_joining(p jsonb)` — SECURITY DEFINER, `search_path = podium, public`, execute granted to
  service_role only (pattern: 0007/0008). In one transaction:
  1. Lock the application `for update`; require `status = 'accepted'`; its latest offer revision `accepted`
     (reuse the 0008 "latest" logic); a `work_accounts` row for it with `status = 'created'`; candidate
     `employee_id is null` (else `rehire_not_supported_yet`). Idempotency: if the application is already
     `joined` and `work_accounts.employee_id` exists → return that employee, change nothing.
  2. Insert the employee with id = `p.employee_id` (the worker allocates it and stores it on work_accounts first):
     `employee_code` = 'EMP-' || lpad(next_employee_seq()::text, 3, '0'); full_name, personal_email, phone from the
     candidate; work_email + google_user_id + google_org_unit from work_accounts; department_id, job_role_id,
     manager_id (= reporting_manager_employee_id), employment_type, legal_entity from the opening; job_title =
     offer.designation; work_location = offer.location or opening city; date_joined = p.start_date;
     probation_end_date = start + offer.probation_months months (null if none); status 'active';
     synced_from_google_at null; created_by = p.actor.
  3. `candidates.employee_id` = the new id.
  4. `compensation_events`: event_type 'initial', effective_date = start, new_ctc = offer.total_ctc, components =
     p.components (the worker computes `componentsContract(annexure, offer)` — same as payouts), currency INR,
     reason = 'offer ' || offer_ref || ' r' || revision, approved_by = p.actor, created_by = p.actor.
     If `settings.comp_vault_enabled` is false, write new_ctc/components NULL (mirrors addCompensationEvent).
  5. `documents` rows from `p.documents` (array of {storage_path, doc_type, title, file_name, mime_type,
     file_size}) — every path must start with `<employee_id>/`; the worker has already copied the objects.
  6. Application → `joined`, `closed_at = now()`, plus the same application event row the other RPCs write.
  7. Opening → `filled` when count(applications joined) >= headcount.
  Errors are raised as `podium_<code>` the worker maps (pattern: offerDbErrorCode).
- Widen nothing else. `employees.status` already allows 'notice'. Application `no_show` already exists.

## Pure module `podiumops-worker/src/workaccount.js` (+ `test/workaccount.test.mjs`)

- `splitName(full)` → `{given, family}`: first token / last token; one-token names → family = given.
  Strip honorifics (Mr, Ms, Mrs, Dr). Trim, collapse spaces.
- `asciiLocal(s)` → lowercase, NFKD + strip diacritics, keep `[a-z0-9]` only.
- `proposeLocalParts(given, family)` → `[given, given + '.' + family[0]]` (L1), deduped, empties dropped.
- `checkLocalPart(s)` → null or an error code: 1–64 chars, `[a-z0-9.]`, no leading/trailing/double dot.
- `WORK_DOMAIN = 'legendoftoys.com'`; `toEmail(local)`.
- `tempPassword(randomBytes)` → 16 chars from an unambiguous set (no 0/O/1/l/I) with ≥1 upper, lower, digit, symbol.
  Takes the byte source as an argument so tests are deterministic; the worker passes crypto.getRandomValues.
- `isOurPendingAccount(row, gUser)` → true when the row is `pending|failed`, same lowercased email, and
  `gUser.creationTime >= row.created_at - 5 min` (so a retry links the account our earlier call created, but never
  adopts an older stranger's account).
- `candidateDocToEmployeeDocType(t)`: cv→resume, signed_offer→offer_letter, id_proof→id_proof,
  address_proof→address_proof, education→education_cert, bank→bank_details, everything else→other.
- `employeeDocPath(employeeId, candidateDocId, fileName)` → `<employee_id>/hiring/<candidateDocId>_<safe name>`.
- `defaultOu(departmentId, employees)` → the most common `google_org_unit` among active employees of that
  department, else '/'.

## Worker `podiumops-worker/src/index.js`

Gate helper `requireGoogleAdmin(auth, env)`: a row in `google_admin_access` for `auth.userId`. getMe adds
`podium_google_admin: bool` to permissions (display only; every handler re-checks).

- **GET `getWorkAccount?application_id=`** (hiring visibility rules of the application + google admin to see the
  form): returns `{application status, offer accepted?, rehire?, work_account row (no secrets), proposals:
  [{email, available, reason}], ous: [distinct orgUnitPath from fetchGoogleUsers], default_ou, given, family,
  start_date (offer)}`. Availability: `users.get` with the READONLY token (200 → taken; 404 → free; also taken if
  any `employees.work_email` or a non-failed `work_accounts.email` matches). ≤ 3 lookups.
- **GET `checkWorkEmail?local=`** (google admin): one availability answer for the Custom box.
- **POST `createWorkAccount {application_id | null, override_reason?, local_part, given_name, family_name,
  org_unit_path}`** (google admin):
  1. Validate local part, OU ∈ the live OU list, names non-empty ≤ 60. Application path: accepted + latest offer
     accepted, not rehire, no non-failed work_accounts row → else the matching code. Override path: no
     application, reason ≥ 10 chars.
  2. Insert/refresh the `work_accounts` row as `pending` BEFORE calling Google (a 23505 on email → `email_taken`).
  3. `users.get` the email with the write token: exists + `isOurPendingAccount` → link it (log `link_existing`);
     exists otherwise → mark failed `email_taken`.
  4. `users.insert` {primaryEmail, name {givenName, familyName}, password, changePasswordAtNextLogin: true,
     orgUnitPath}. 409 → failed `email_taken` (groups/aliases). Other error → failed with Google's message.
  5. Row → `created` + google_user_id; log `create_user` with request minus password; respond
     `{email, temp_password}` — the only place the password ever exists. Never console.log it, never store it.
- **POST `confirmJoining {application_id, start_date}`** (podium_hiring/HR — the hiring gate used by
  recordOfferAcceptance; not Google admin): start_date valid ISO, not more than 7 days in the future, not before
  the offer was accepted. Allocate/store `work_accounts.employee_id` (crypto.randomUUID) if null. Copy every
  candidate_document of the candidate (+ the issued offer PDF `offers.pdf_path` as offer_letter) with Storage
  `POST /object/copy {bucketId, sourceKey, destinationKey}` (409 = already copied = fine). Then the RPC with
  `{application_id, employee_id, start_date, actor, components, documents}`. Return the employee id + code.
- **POST `markNoShow {application_id, note}`**: accepted → `no_show` (extend APP_TRANSITIONS: accepted →
  ['withdrawn','no_show']); reason optional. Uses the existing move RPC.
- **POST `suspendWorkAccount {work_account_id}`** (google admin): only when its application is `no_show` or
  `withdrawn` (X1 widens this later). `users.update {suspended: true}` with the write token; row → `suspended`;
  log `suspend_user`.
- **Directory sync:** emails of `work_accounts` rows tied to an application and not yet joined are shown as
  "Created by Podium — awaiting joining" and REFUSED by the sync create path (`created_by_podium_awaiting_joining`).
  Everything else new in Google is labelled "Created outside Podium" (wording only).
- Register the new GET/POST actions next to the hiring ones; none in SELF_SERVE.

## App `apps/podium`

- `/hiring/detail` (application block, status accepted / joined / no_show): a **Work account** card.
  - No account + google admin: given/family inputs (prefilled), address radio: proposal 1, proposal 2 (each with an
    available/taken badge), Custom (`[local] @legendoftoys.com` + Check). OU select (default_ou). Create.
    Non-admins see "A Google admin (Afshaan, Vinay, Mohit) creates the account."
  - On success: a modal with the email and the temp password, a Copy button, the line "Shown once — Podium does not
    keep it", and a close button labelled "I've noted it".
  - Account created: email + created by/at; **Confirm joining** (date, default today) and **Mark no-show**.
  - Joined: link to the employee page. No-show/withdrawn with an active account: **Suspend account** (google admin).
  - Rehire: a notice, no buttons.
- `/people` Directory sync modal: the two new labels; awaiting-joining rows have no import checkbox.
- `/people`: a "Create account without hiring" action for google admins (override: reason required) — same form,
  no application.

## Tests / done

- `test/workaccount.test.mjs` covers every pure function, incl. one-token names, diacritics, a taken first proposal,
  a password distribution check over 1,000 draws, isOurPendingAccount's 5-minute window both sides.
- Existing 92 tests stay green; `npx turbo build --filter=podium` zero errors; `wrangler deploy --dry-run` ok.
- No real candidate names or salary figures anywhere in fixtures.
