# Scanner device identity — design (2026-08-27, S319)

> **Status:** APPROVED 2026-08-27 by Afshaan — building Phase 1 (log-only). His three rulings on the
> open questions are folded in below (§3 queue, §5 break-glass, §5 platform).
> **Problem:** 19 writes in the `SCANNER_ACTIONS` chain are reachable with no credential of any
> kind, plus a 4-handler tier that checks a device exists but not that it is active.
> **Afshaan's constraint (2026-08-27):** no per-device Google logins (cost per seat), and no shared
> secret — "that's the same problem as a department pin, anyone can have it". He asked for a
> registered-device model: enrol once, any new device is flagged and blocked. Attendance must be
> locked to one device — the security guy at the factory gate.

---

## 1. Why today's `device_code` is not an identity

`validateDevice(deviceCode)` (`01_worker/worker.js:730`) looks up `public.devices` by
`device_code` with `is_active=eq.true`. That part is sound. The weakness is what `device_code`
*is*: a string typed at setup and kept in **`localStorage`** (`02_scanner/index.html`, `lot_cfg`
— 14 call sites, no IndexedDB, no WebCrypto anywhere in the file).

A `localStorage` value can be read from devtools, screenshotted, or dictated over the phone. So
`device_code` authenticates a *value*, not a *device*, and a shared secret is precisely the
department-PIN failure mode Afshaan rejected. Two further holes sit on top of it:

- **19 handlers never call `validateDevice` at all** — they run before the JWT gate, so they need
  no credential whatsoever. Includes `markShipmentShipped`, `updateChannel`, and all four
  attendance writes.
- **`postDtk` / `postAlloc` / `postPack` / `postDout` look the device up by `device_id`
  directly** (`queryPublic('devices','?id=eq.…')`) and never check `is_active` — a decommissioned
  device still works, including the handler that records units physically leaving.

## 2. The mechanism: a non-extractable keypair per device

Browsers can generate a keypair whose **private half is never readable by JavaScript**:

```js
const kp = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,                       // extractable: false — this is the whole point
  ['sign', 'verify']
);
```

With `extractable:false`, `crypto.subtle.exportKey()` **throws**. The `CryptoKey` can be
structured-cloned into IndexedDB and used to sign forever, but its key material cannot be read,
copied, screenshotted, or dictated. Copying a device's `localStorage` onto another phone yields
the `device_code` and no ability to sign with it.

**This is the property `device_code` lacks, and it costs nothing** — no Google seats, no
per-device licence, no vendor. It is native to every modern browser.

### Enrolment (once per device, permission-gated in Garage)

1. Supervisor opens the device row in Garage → **Enrol device** → worker mints a **one-time
   enrolment code** (short TTL ~15 min, single use, bound to that `device_code`).
2. On the device, the scanner setup screen takes the code.
3. Scanner generates the keypair (above), stores the private `CryptoKey` in IndexedDB.
4. Scanner posts `{ device_code, enrolment_code, public_key }` → worker verifies the code, writes
   `devices.device_pubkey` / `enrolled_at` / `enrolled_by`, burns the code.

### Every scanner call thereafter

Scanner signs a canonical string and sends it in headers:

```
canonical = `${action}|${device_code}|${ts}|${nonce}|${sha256(body)}`
X-LOT-Device, X-LOT-TS, X-LOT-Nonce, X-LOT-Sig
```

Worker, **once at the top of the `SCANNER_ACTIONS` chain** — one check, not 19:

- resolve device by `device_code`; reject if absent, `is_active=false`, or `device_pubkey` null
- verify the signature against the stored public key
- reject if clock skew > ±2 min, or the nonce has been seen (replay guard)
- on any failure → **401 + a row in `public.device_auth_failures`** (attempted `device_code`, IP,
  action, timestamp) so an unenrolled device shows up as a flag rather than silence

This also closes the fourth tier for free: `postDtk`/`postAlloc`/`postPack`/`postDout` inherit the
same gate, so `is_active` is finally enforced on them.

## 3. Attendance — locked to exactly one device

Afshaan: *"I do not want anyone to be able to access it except the security guy at the factory and
it should be locked to that one device."*

- Add `devices.is_attendance_device boolean not null default false`, plus a **partial unique
  index** `create unique index … on public.devices (is_attendance_device) where is_attendance_device`
  — so **at most one device fleet-wide** can hold it. DB-enforced, not convention: a second device
  cannot be flagged even by a direct write.
- `clockIn` / `clockOut` / `recordAttendance` / `recordBreak` require a valid signature **AND**
  `device.is_attendance_device = true`. Every other device → 403, logged.

> 🔴 **BLOCKER FOUND BY HOSTILE REVIEW OF THIS OWN SPEC (2026-08-27, S319) — read before Phase 3.**
> **Attendance calls carry NO `device_code` today, so this rule as drafted would refuse 100% of
> them.** Phase 1 proved it within minutes of going live: `recordAttendance` and
> `getOperatorByCode` both logged with an **empty** device code at 19:01 IST. That is not a bug —
> RULE-SCAN-001 makes attendance deliberately **deviceless** (`needsOperator()` excludes it because
> the operator gate requires a `device_code`), which is precisely *why* any phone can reach it.
>
> The design above silently assumed a `device_code` was present to compare against
> `is_attendance_device`. It is not. **Enforcing Phase 3 without fixing this stops every operator
> clocking in — the exact floor-stopping outcome the phased rollout exists to prevent.**
>
> **Required before the attendance flip:** the scanner's attendance path must be given a device
> identity and must send `X-LOT-Device` + the signature headers explicitly. Attendance is currently
> the ONE station with no device setup step, so this is new work, not a config change — budget for
> it. ⚠️ Do NOT "solve" this by falling back to `body.data.device_code` for attendance: the field
> is absent, so the fallback resolves to empty and the gate would pass for everyone, which is worse
> than failing closed.
- Toggled from the Garage `/users` super-admin card that already holds Scanner PINs.

⚠️ **This is a real floor change, not just a lock.** Attendance is currently **deviceless** by
design — RULE-SCAN-001's `needsOperator()` excludes Lookup and Attendance because the operator gate
requires a `device_code`, which is why any phone opening the scanner URL can reach it today.
Binding it to one device means **every operator must physically pass the security desk to clock in
and out**. That is presumably the intent (it is what a gate guard is for), but two consequences
follow and should be decided, not discovered:

- **Shift-start queueing — ✅ ACCEPTED (Afshaan, 2026-08-27).** ~40+ operators clocking in through
  one device in a narrow window is fine. The rule stays literally **one device fleet-wide**, so the
  partial unique index below is the correct enforcement and must NOT be relaxed to per-gate.
- **Single point of failure — ✅ break-glass approved (Afshaan, 2026-08-27), see §5.**

⚠️ **Announce before the attendance flip.** Afshaan: tell **Shashwat, Piyush and Rahul RP** once
this is built, so nobody is caught out at the next morning's clock-in — attendance specifically,
and any other station the enforcement reaches. The flip must not be the first they hear of it.

## 4. Rollout — cannot be a single flip

Forty-odd devices cannot all enrol at once, and a bad flip stops the floor.

- **Phase 1 — log only.** Ship the verification path accepting signatures but **blocking nothing**;
  record every unsigned call. This produces a live inventory of which devices actually exist and
  which handlers are genuinely called from where — better data than any audit.
- **Phase 2 — enrol** from that inventory, device by device, during normal shifts.
- **Phase 3 — enforce**, per department, lowest-risk first. Attendance is its own flip (one device,
  so it is the easiest to enrol and the highest-consequence to get wrong).
- **Break-glass throughout:** see §5.

## 5. Break-glass (approved 2026-08-27)

Key loss is **routine, not exceptional** — clearing browser data, reinstalling the PWA, or swapping
a device all destroy the key. Two super-admin actions, both logged to `store.activity_log`:

- **`resetDeviceEnrolment(device_code, reason)`** — clears `device_pubkey`, mints a fresh one-time
  enrolment code on the spot. Device re-enrols in under a minute. This is the everyday path and
  will be used regularly; it must be one screen, not a ticket.
- **`moveAttendanceDevice(from_device, to_device, reason)`** — re-points `is_attendance_device` in
  a **single transaction** (clear old, set new), because the partial unique index makes a two-step
  update fail halfway. This is the answer to "the gate device died at 8am", and it is why the
  one-device rule does not become a floor-stopping SPOF.

⚠️ **Break-glass must never be a way to bypass enrolment** — both actions produce a device that
still has to enrol before it can sign. They shorten the recovery, they do not create an exemption.

The floor-facing failure text must read **"This device is not registered — see your supervisor"**,
never a bare red buzz. An unexplained refusal is the failure mode that makes people stop scanning.

## 5b. Platform — settled

**The floor is Android (Afshaan, 2026-08-27).** The iOS Safari 7-day IndexedDB eviction concern is
therefore **moot** and is not a rollout blocker. Chrome/Android persists IndexedDB indefinitely for
an installed PWA. Retest only if iOS hardware is ever introduced.
- **Deploy blast radius:** lotopsproxy serves Garage + Redline + Scanner + Depot. Ships alongside a
  scanner deploy, with a floor smoke.

## 6. What this does and does not fix

**Fixes:** the 19 uncredentialled writes; the 4 `is_active`-blind handlers; device sharing by
copying a code; unenrolled devices reaching the API at all; attendance being open to any phone.

**Does not fix:** an *enrolled* device in the wrong hands. Buddy-punching by someone standing at
the security desk is unchanged — that residual risk was accepted socially in S199 and this design
does not alter it. It narrows the attack surface from "anyone on the internet" to "someone holding
an enrolled device", which is the achievable goal.

**Separately still open (JWT-authenticated but no permission check, lower severity — any LOT login,
not the public):** `createPartPhotoUploadUrl`, `recordPartPhoto`, `setPrimaryPartPhoto`,
`deletePartPhoto`, `createAuditRound`, `addAuditFinding`.
