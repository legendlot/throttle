-- snorkel_vendor_udyam_v1 (2026-09-29, S403): Udyam (MSME) registration number on a vendor.
-- Prarthi, #bugs 1790687279 — "add one more field in vendor details for the udhyam registration
-- number". Format UDYAM-<state>-<district>-<7 digits>. snorkelops normalises (strip whitespace,
-- uppercase, '' → NULL) before writing; the CHECK is the backstop and must match UDYAM_RE in
-- snorkelops-worker/src/index.js — change the two together.
alter table store.vendors
  add column if not exists udyam_number text;

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'vendors_udyam_number_shape' and conrelid = 'store.vendors'::regclass) then
    alter table store.vendors
      add constraint vendors_udyam_number_shape
      check (udyam_number is null or udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');
  end if;
end $$;

notify pgrst, 'reload schema';
