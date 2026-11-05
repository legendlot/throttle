-- ignition_deal_contracts_v1 — send brief + contract, creator accepts, Shipping locked (Reann #1, #bugs 1793690997.941679)
--
-- ⛔ APPLY BEFORE DEPLOYING THE WORKER. advanceStage now selects engagements.contract_required;
-- PostgREST errors on an unknown column, the worker reads that as not_found, and EVERY stage move
-- would fail until this lands.
--
-- 1. The deal. Only deals in proposed or planning today come under the lock (plus every new video
--    deal); everything else has already moved on. Both columns are new, so nothing existing is lost.
alter table ignition.engagements add column if not exists deliverables text;
-- Added as false, the 16 in-scope deals set true, then the default flips: this touches 16 rows, not 712.
alter table ignition.engagements add column if not exists contract_required boolean not null default false;

update ignition.engagements
set contract_required = true
where engagement_type is distinct from 'ugc' and stage in ('proposed', 'planning');

alter table ignition.engagements alter column contract_required set default true;

comment on column ignition.engagements.contract_required is
  'Shipping lock applies to this deal once the wording is published. Worker-set, not in ENGAGEMENT_FIELDS.';

-- 2. The wording. Reann owns it; unpublished means sending and the lock are both OFF.
create table if not exists ignition.contract_settings (
  id            int primary key default 1 check (id = 1),
  subject       text,
  dos_and_donts text,
  terms         text,
  published_at  timestamptz,
  published_by  uuid,
  updated_at    timestamptz,
  updated_by    uuid
);
insert into ignition.contract_settings (id) values (1) on conflict (id) do nothing;

-- 3. One row per send. `body` is the text a person checked; the accept link is appended by the
--    server at send time and is NOT stored, so the database holds only token_hash.
create table if not exists ignition.deal_contracts (
  id                  uuid primary key default gen_random_uuid(),
  engagement_id       uuid not null references ignition.engagements(id) on delete cascade,
  influencer_id       uuid references ignition.influencers(id) on delete set null,
  status              text not null check (status in ('sending','sent','failed','superseded','accepted','accepted_by_hand')),
  to_email            text,
  subject             text,
  body                text,
  body_sha256         text,
  token_hash          text unique,
  gmail_message_id    text,
  error               text,
  sent_by             uuid,
  sent_at             timestamptz,
  accepted_at         timestamptz,
  accepted_ip         text,
  accepted_user_agent text,
  by_hand_reason      text,
  by_hand_by          uuid,
  created_at          timestamptz not null default now()
);
create index if not exists deal_contracts_engagement_idx on ignition.deal_contracts (engagement_id);
-- One send in flight per deal: a double-click cannot mail two links.
create unique index if not exists deal_contracts_one_sending_idx
  on ignition.deal_contracts (engagement_id) where status = 'sending';

-- 4. Bank details, per influencer. Names match store.payment_payees + payment_payee_banks so item 2
--    can map them across. No surface returns the full number or PAN (maskBank).
create table if not exists ignition.influencer_bank_details (
  influencer_id  uuid primary key references ignition.influencers(id) on delete cascade,
  account_name   text,
  account_number text,
  ifsc           text,
  bank_name      text,
  upi_id         text,
  pan            text,
  gstin          text,
  submitted_at   timestamptz,
  contract_id    uuid references ignition.deal_contracts(id) on delete set null,
  editable_until timestamptz,
  reopen_contract_id uuid references ignition.deal_contracts(id) on delete set null
);

-- 5. Invoices the creator uploads.
create table if not exists ignition.deal_invoices (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references ignition.engagements(id) on delete cascade,
  contract_id   uuid references ignition.deal_contracts(id) on delete set null,
  path          text not null unique,
  file_name     text,
  mime          text,
  uploaded_at   timestamptz not null default now()
);
create index if not exists deal_invoices_engagement_idx on ignition.deal_invoices (engagement_id);

-- 6. Service role only. The worker is the one door.
alter table ignition.contract_settings      enable row level security;
alter table ignition.deal_contracts         enable row level security;
alter table ignition.influencer_bank_details enable row level security;
alter table ignition.deal_invoices          enable row level security;

revoke all on ignition.contract_settings, ignition.deal_contracts, ignition.influencer_bank_details, ignition.deal_invoices
  from anon, authenticated;
grant all on ignition.contract_settings, ignition.deal_contracts, ignition.influencer_bank_details, ignition.deal_invoices
  to service_role;

-- 7. Private bucket for invoices: 10 MB; pdf, jpeg, png.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ignition-creator-invoices', 'ignition-creator-invoices', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';
