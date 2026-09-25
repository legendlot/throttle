-- 0078 — Relay voice channel: the call ledger (S400, 2026-09-25).
--
-- WHY NOW. LimeChat answered the voice Q&A (#bugs 1790255060.947059, "LC Q&A.pdf"): Relay CAN
-- initiate the call through their Custom Events API, they send a call-started AND a call-ended
-- webhook (real time, seconds), and the payload is OURS to define. So the orchestration lives
-- here (Afshaan, 2026-09-25: "orchestration happens at our end … we should have all the details
-- regarding those calls"): Relay decides who is called and when, LimeChat is the dialler.
-- Spec: 05_Throttle/docs/superpowers/specs/2026-09-02-relay-voice-channel-limechat-design.md §5, §14.
--
-- ONE ROW PER CALL. `id` IS the `call_ref` we send LimeChat and they echo back on both webhooks;
-- that echo is the ONLY thing that lets an outcome act on anything (S372 prerequisite: a payload
-- that does not name a call we requested is stored and ignored — a leaked static token is then
-- near-useless for triggering sends).
--
-- ⚠️ Transcripts live HERE, never in comms.events.properties (spec §5: a transcript is 1.3–5× the
-- largest events payload that has ever existed, and getProfile selects * over the last 50 events).
-- The event emitted on call end carries only scalars.
create table if not exists comms.voice_calls (
  id                uuid primary key default gen_random_uuid(),   -- = call_ref
  connector         text not null default 'limechat',
  -- 'relay' = we asked for it; 'vendor_triggered' = an outcome for a call we never requested
  -- (LimeChat dialling off its own Shopflo integration). Stored for total capture, never acted on.
  origin            text not null default 'relay' check (origin in ('relay','vendor_triggered')),
  purpose           text not null check (purpose in ('abandonment','cod_confirmation','manual','test','unknown')),
  flow              text,                                         -- 'cart' | 'checkout' | free
  profile_id        uuid references comms.profiles(id),
  phone             text not null,                                -- E.164, +91…
  -- Lifecycle, OURS. skipped = our gate refused (no vendor call) · requested = LimeChat accepted
  -- the request · request_failed = LimeChat refused / unreachable · started = call-started
  -- webhook · ended = call-ended webhook · timed_out = no signal inside the window (the sweep).
  status            text not null default 'requested'
                    check (status in ('skipped','requested','request_failed','started','ended','timed_out')),
  skip_reason       text,
  -- What happened on the line — our closed vocabulary; their raw string stays in provider_status.
  call_status       text check (call_status in ('answered','no_answer','busy','failed','not_dialled')),
  -- What the customer said. Part A (abandonment, Pruthvi's v3 doc): wants_link · followup_ok
  -- (not interested, OK with a follow-up) · opt_out (do not contact) · unresolved. Part B (COD):
  -- confirmed · cancelled · wants_human · unresolved. no_pickup when nobody answered.
  disposition       text check (disposition in ('wants_link','followup_ok','opt_out','unresolved',
                                                'confirmed','cancelled','wants_human','no_pickup')),
  discount_agreed   boolean,
  drop_reason       text,                                         -- "why did you drop off?"
  provider_call_ref text,                                         -- their call_id
  provider_status   text,                                         -- their raw call_status, never interpreted
  summary           text,
  transcript        text,
  recording_url     text,
  duration_seconds  integer,
  context           jsonb not null default '{}'::jsonb,            -- what we sent them
  raw               jsonb,                                        -- last vendor payload, whole
  journey_id        uuid,
  enrolment_id      uuid,
  campaign_id       uuid,
  requested_by      text,                                         -- staff email for a manual call
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A FULL unique constraint, not a partial index: it must be usable as an ON CONFLICT target for
  -- vendor_triggered upserts (a partial unique index cannot be — the S3xx trap). NULLs stay distinct.
  constraint voice_calls_provider_ref_uq unique (connector, provider_call_ref)
);

create index if not exists voice_calls_phone_idx   on comms.voice_calls (phone, requested_at desc);
create index if not exists voice_calls_profile_idx on comms.voice_calls (profile_id, requested_at desc);
create index if not exists voice_calls_open_idx    on comms.voice_calls (status, requested_at)
  where status in ('requested','started');

grant all on comms.voice_calls to service_role;
alter table comms.voice_calls enable row level security;

-- TRAI: calls only 09:00–21:00 IST. Stored as the QUIET window (21:00→09:00), same table and
-- resolver as every other channel. Without a row, voice would inherit the global 22:00–08:00 —
-- MORE permissive than the law (spec §6).
insert into comms.channel_quiet_hours (channel, enabled, start_time, end_time, note)
values ('voice', true, '21:00', '09:00', 'TRAI: outbound calls 09:00–21:00 IST only (S400, voice channel)')
on conflict (channel) do nothing;
