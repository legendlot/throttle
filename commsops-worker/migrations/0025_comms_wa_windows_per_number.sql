-- comms_wa_windows_per_number_v1 — Meta's 24h service window is per (business number ↔ customer),
-- not per customer (review H5 part 3). Old rows keep phone_number_id='' and age out in 24h.
ALTER TABLE comms.wa_windows ADD COLUMN IF NOT EXISTS phone_number_id text NOT NULL DEFAULT '';
ALTER TABLE comms.wa_windows DROP CONSTRAINT wa_windows_pkey;
ALTER TABLE comms.wa_windows ADD PRIMARY KEY (identifier_value, phone_number_id);
