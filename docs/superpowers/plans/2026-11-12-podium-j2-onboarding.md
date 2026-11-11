# Podium J2 — Onboarding (joiners) + profile completion (everyone, once)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` → "J2" (v4.1) + decision L4 (policies ship
empty, co-created later). Builds on J1 (`hiring_confirm_joining`, work accounts) and X1 (`exit_checklist_*`
snapshot pattern, `exits.js` pure-rules pattern — copy both shapes).

## Measured before planning (2026-11-12, 64 active employees)

- Filled today: DOB 41 · gender 23 · blood group 5 · PAN 45 · personal email 16 · phone 30 · **emergency contact 0**
  · date_joined 63 · login linked 61 · work email 63. **Zero** `bank_details` / `id_proof` documents on actives.
- The XPayroll onboarding sheet (Drive `XPayroll-Onboarding-v1-2`, tab "Employee Data", row 2 = headers) has,
  in this order: Employee ID · Name · Email · Date of Hiring (DD/MM/YYYY) · Professional Tax Location (State) ·
  Title · Department · Annual CTC · PAN · Provident Fund? (Y/N) · PF UAN · ESIC Number · Taxable salary paid in
  current F.Y. till now by current employer outside XPayroll · Exemptions in current F.Y. till now · TDS deducted
  in current F.Y. till now · Past Taxable Salary · Past TDS · Phone Number · Gender (M/F/Other) · Date of Birth
  (dd/mm/yyyy) · Bank Account Number · Bank IFSC Code. **The export reproduces these headers verbatim.**
- `store.assets` categories in use: "IT / Computers" (76), "Machinery" (1); custody is `custodian_user_id` (auth
  user), statuses in_use / in_storage / damaged / in_repair / retired.

## Decisions taken in the plan (record in the spec when shipped)

1. **Sensitive fields live in a NEW 1:1 table `podium.employee_private`, not on `employees`.** `employees` is read
   with `select=*` / `EMP_EMBED` in dozens of worker paths (directory, org chart, team, appraisals); one missed
   strip would leak bank details. A separate table is read by exactly two handlers. PAN stays where it is
   (`employees.pan_number`, `stripPan`).
2. **Visibility tiers:** bank account + IFSC + UAN + ESIC + addresses → **self or HR** (HR UI shows bank account
   masked `••••1234`; full value only to self and in the export). Past-employer taxable salary / TDS and current-FY
   figures → **self or `canComp`** (salary-tier, logged to `comp_access_log` like every cross-person salary read).
3. **The XPayroll export requires `canComp`** (it carries Annual CTC and past salary) and is logged. HR without comp
   access sees the board but not the export button.
4. **After a field is first filled, a self-change of PAN or bank account / IFSC becomes a pending change request**
   that HR approves (spec: "HR approval on PAN/bank changes"). Every other profile field stays self-editable.
   First fill (value was null) applies immediately.
5. **Onboarding starts automatically** when `confirmJoining` succeeds (J1), best-effort: a failure never fails the
   joining; the HR board lists "joined without an onboarding" with a Start button. HR may also start one by hand for
   any active employee with none (joiners added outside J1).
6. **Auto lines are computed, never ticked by hand** (X1's `lot_access` rule): profile complete, documents uploaded,
   policies acknowledged, login linked, IT kit issued (≥1 non-retired `store.assets` row with `custodian_user_id`
   = their login), probation end date set. They show live status; the onboarding completes when every required
   line is resolved. HR may mark an auto line done **with a note** only when it cannot be verified (no login linked
   → assets/policies unverifiable), same as X1's unverifiable-assets rule.
7. **Nothing gates payroll** — J2 records, it never blocks RazorpayX or any other flow.

## Data (migration `podiumops-worker/migrations/0011_onboarding.sql`, applied as `podium_onboarding_v1`)

- `podium.employee_private` — `employee_id uuid pk fk employees`, `current_address text`, `permanent_address text`,
  `pf_uan text check (~ '^[0-9]{12}$')`, `esic_number text check (~ '^[0-9]{10,17}$')`, `bank_account_number text
  check (~ '^[0-9]{9,18}$')`, `bank_ifsc text check (~ '^[A-Z]{4}0[A-Z0-9]{6}$')`, `bank_account_name text`,
  `fy_label text` (e.g. '2026-27'), `cur_fy_taxable_outside numeric`, `cur_fy_exemptions numeric`, `cur_fy_tds
  numeric`, `past_taxable_salary numeric`, `past_tds numeric` (all ≥ 0), `updated_at`, `updated_by`. Fix trivial
  input at the source form (strip spaces, uppercase IFSC) — the CHECKs are the backstop.
- `podium.profile_change_requests` — `id`, `employee_id`, `field text check in ('pan_number','bank_account_number',
  'bank_ifsc','bank_account_name')`, `new_value text`, `status check in ('pending','approved','rejected')`,
  `requested_by`, `requested_at`, `decided_by`, `decided_at`, `decision_note`. Partial unique: one pending per
  (employee, field). Applying an approval is an RPC (lock employee, re-check pending, write the field, close row).
- `podium.policies` — `id`, `title`, `version int ≥ 1`, `storage_path text` (PDF in the existing private
  `podium-documents` bucket under `policies/`), `applies_to text[]` (employment types; empty = all), `active`,
  `published_at`, timestamps. Unique (title, version). **Seeded empty** (L4).
- `podium.policy_acknowledgements` — `id`, `employee_id`, `policy_id`, `version int`, `acknowledged_at`; unique
  (employee_id, policy_id, version); append-only (`refuse_event_mutation`).
- `podium.onboarding_lines` — admin-editable TEMPLATE, same shape as `exit_checklist_lines` plus `due_offset_days int`
  (relative to `date_joined`; may be negative = before day one). `owner check in ('hr','manager','it','employee')`,
  `auto_source check in ('profile','documents','policies','login','it_kit','probation_date')`. Seed:
  employee: profile complete (auto profile, +3) · documents uploaded (auto documents, +7) · policies acknowledged
  (auto policies, +7) — IT: LOT login linked (auto login, 0) · IT kit issued (auto it_kit, 0) · app access set up
  (manual, +1) — Manager: first-week plan shared (+0) · probation goals set (+14, note may carry an OKR link) ·
  buddy assigned (+0) — HR: payroll set up / XPayroll export done (+7) · PF / ESI registration (+30, allow_na) ·
  probation end date set (auto probation_date, +7) · welcome email sent (0, not required).
  `applies_to`: interns skip PF / ESI registration (allow_na anyway).
- `podium.employee_onboardings` — `id`, `employee_id`, `status check in ('open','complete','cancelled')`,
  `started_by`, `started_via check in ('joining','hr')`, `completed_at`, `cancelled_at/by/reason`, timestamps.
  Partial unique: one `open` per employee.
- `podium.onboarding_items` — snapshot at start (X1 pattern) + `due_date date` (date_joined + offset; null when
  date_joined is null), `status open/done/na`, `note`, `done_by`, `done_at`. Unique (onboarding_id, line_key).
- `podium.settings` + `profile_campaign_launched_at timestamptz`, `profile_campaign_launched_by uuid`,
  `profile_required_doc_types text[] default '{id_proof,address_proof,bank_details}'`, `pt_state text default
  'Karnataka'` (the export's Professional Tax Location).
- RLS on, service_role only, grants like 0010; every new function SECURITY DEFINER + pinned search_path +
  service_role-only execute; end with `notify pgrst, 'reload schema'`.
- RPCs: `onboarding_start(p)` (lock employee, refuse exited / already open, snapshot lines filtered by
  applies_to, compute due dates), `onboarding_update_item(p)` (lock employee → onboarding → item; refuse auto
  lines unless HR + note + the auto check is unverifiable; manager only `owner='manager'` lines),
  `onboarding_complete(p)` (all required resolved, auto lines re-checked live inside the RPC → `complete`),
  `profile_change_decide(p)`.

## Worker (`podiumops-worker/src/index.js`; pure rules in new `src/onboarding.js` + `test/onboarding.test.mjs`)

Gates as X1: self = caller's employee; manager = `inManagerChain`; HR = `isHr`; comp = `canComp`.
- **Self-serve (add to SELF_SERVE_*, self-scoped, a no-role joiner must reach them):**
  - GET `getMyProfile` → own `employees` profile fields + own `employee_private` (full values) + own documents list
    (restricted types included — they're theirs) + applicable active policies with ack status + own open onboarding
    (items, live auto status) + pending change requests + `missing[]` (the completion rule below).
  - POST `saveMyProfile {fields}` → whitelist: preferred_name, personal_email, phone, emergency_contact_name,
    emergency_contact_phone, date_of_birth, gender, blood_group, pan_number + every `employee_private` column.
    PAN / bank fields that already hold a value → a change request, not a write. Validate formats (PAN
    `^[A-Z]{5}[0-9]{4}[A-Z]$`, phone 10 digits, IFSC, UAN) with friendly messages.
  - POST `uploadMyDocument` (or extend the existing upload with a self path) → only doc types in
    `profile_required_doc_types` + `education_cert` + `photo`/`other`; storage path under the employee; never
    overwrites HR uploads.
  - POST `acknowledgePolicy {policy_id, version}` → must be the current active version and apply to them.
  - GET `getPolicyFile {policy_id}` → signed URL, self (applicable) or HR.
- **Completion rule (one function, used by the banner, the board and the `profile` auto line):** required =
  date_of_birth, gender, personal_email, phone, emergency_contact_name + _phone, pan_number, current_address,
  bank_account_number, bank_ifsc, + each of `profile_required_doc_types` uploaded. PF UAN / ESIC / past salary are
  optional (not everyone has them). Return the missing list with human labels.
- **HR / manager:**
  - GET `getOnboardingBoard` (HR) → open onboardings × items (overdue = open + due_date < IST today), joiners
    without an onboarding (active, date_joined within 90 days, none open/complete), campaign stats.
  - GET `getProfileCompletion` (HR) → per active employee: missing field labels (never the values), completion %;
    per-field totals.
  - GET `getOnboarding?employee_id=` (self, chain, HR) → that person's onboarding (manager sees all lines; ticks only
    manager lines).
  - POST `startOnboarding {employee_id}` (HR), `updateOnboardingItem {item_id, status, note}` (HR / manager-chain),
    `completeOnboarding {onboarding_id}` (HR), `cancelOnboarding {onboarding_id, reason}` (HR).
  - POST `launchProfileCampaign` (HR) — sets the settings stamp; idempotent; returns the count of incomplete actives.
  - GET `getProfileChangeRequests` (HR) + POST `decideProfileChange {id, decision, note}` (HR; masked values in
    the list, the RPC applies).
  - GET `getEmployeePrivate?employee_id=` (HR: bank masked, address/UAN/ESIC full; comp: + salary fields, logged).
  - GET `exportXPayroll?employee_ids=` (canComp, logged per employee) → CSV with the sheet's headers verbatim, dates
    DD/MM/YYYY, gender M/F/Other, PF Y/N from the latest offer/comp statutory flags if present else blank, Annual CTC
    from the current comp row (vault rules apply), PT location = settings.pt_state.
  - Admin (HR / podium_admin): `getOnboardingTemplate` / `saveOnboardingLine`, `getPolicies` / `savePolicy` (upload
    PDF; publishing a new version = a new row; old acks stay valid for the old version only).
- **J1 hook:** after `confirmJoining` succeeds, call `onboarding_start` (`started_via 'joining'`); swallow + report
  failure in the response (`onboarding_started: false`) — never fail the joining.
- **Verify the joiner path for real:** a brand-new J1 account signing in to Podium (no Podium role, maybe no
  `users_profile` yet) must reach the self-serve page. Trace `verifyJWT` / getMe / the auth-link trigger and state in
  the report exactly what happens; if a gate blocks them, fix the gate for these self-scoped actions only.

## App (`apps/podium`)

- **`/welcome` (self, any logged-in employee):** "Your profile" (sections: Personal · Contact & emergency ·
  Address · Bank · Statutory (UAN/ESIC) · Previous employer (optional, salary-tier note)), documents upload,
  policies to read + Acknowledge (PDF opens via signed URL), and — for a joiner — "Your first weeks" (their
  onboarding lines with owners and due dates, read-only). Pending PAN/bank changes show as "awaiting HR approval".
- **Banner** on `/me` and the dashboard: "Complete your profile — N items left" while the campaign is launched (or
  they have an open onboarding) and `missing` is non-empty; links to `/welcome`.
- **`/onboarding` (HR; nav under People):** tabs — Joiners (board: person × line, overdue red, Start / Complete /
  Cancel, "joined without onboarding" list) · Profile completion (launch campaign button, per-field totals, per-person
  missing list) · Change requests (approve / reject) · Export (pick joiners → XPayroll CSV; comp-only).
- **Employee page:** an Onboarding card (manager ticks manager lines; HR all) and, for HR, the private-details card
  (masked bank).
- **`/admin/onboarding-checklist` + `/admin/policies`** (HR / admin) — template lines and policy upload/versions.
- Range pickers default to Today (memory rule) wherever a date filter appears.

## Tests / done

`test/onboarding.test.mjs`: completion rule (each missing field, doc types, optional fields don't count) · format
validators (PAN, IFSC, UAN, phone, bank account; trimming/uppercasing) · first fill vs change-request routing ·
who may tick which line · auto-line resolution + unverifiable rule · due/overdue math in IST · snapshot filtering by
applies_to · XPayroll CSV (header order verbatim, date/gender formats, CSV escaping, comp gate) · masking ·
SQL-text checks on 0011 (service_role only, RLS, partial uniques, append-only acks). Existing 152 tests green;
`node --check`; `wrangler deploy --dry-run`; `npx turbo build --filter=podium` zero errors. No real names, PANs, bank
numbers or salaries in fixtures — synthetic only.
