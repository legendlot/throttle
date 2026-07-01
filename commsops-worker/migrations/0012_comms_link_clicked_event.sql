-- Register the channel-agnostic link_clicked event definition. Emitted from Resend's
-- email.clicked webhook now (carrying the clicked URL); SMS/WhatsApp will emit the SAME
-- name via the Phase-B first-party redirect. The prior 'email_clicked' def (0003 seed) is
-- left in place — harmless; nothing emits it after this. Idempotent (existence-guarded).

INSERT INTO comms.event_definitions (name, description, expected_props)
VALUES ('link_clicked',
        'A recipient clicked a tracked link in an outbound message',
        '{"url":"string","channel":"string","message_id":"string"}'::jsonb)
ON CONFLICT (name) DO NOTHING;
