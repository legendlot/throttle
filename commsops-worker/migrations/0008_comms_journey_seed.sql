-- M7 seed: abandoned-cart journey + its email template + the trigger event definition.
-- Idempotent (existence-guarded) so re-applying is a no-op — templates/journeys have
-- uuid PKs with no unique name constraint, so a blind re-insert would duplicate them.
-- NOTE: render.js binds SINGLE-brace tokens `{token}` (not `{{token}}`); fallbacks
-- keep the journey send from throwing when no event context is threaded (v1: the
-- checkout_url uses its fallback, so the email links generically, not to the exact cart).

INSERT INTO comms.event_definitions (name, description, expected_props)
VALUES ('checkout_started',
        'Shopify checkout created but not completed (abandoned-cart trigger)',
        '{"checkout_url":"string","cart_value":"number"}'::jsonb)
ON CONFLICT (name) DO NOTHING;

DO $$
DECLARE
  v_template_id uuid;
  v_journey_id  uuid;
BEGIN
  -- Abandoned-cart email template (marketing/email, active) — idempotent on name.
  SELECT id INTO v_template_id FROM comms.templates WHERE name = 'Abandoned Cart — 24h' LIMIT 1;
  IF v_template_id IS NULL THEN
    INSERT INTO comms.templates (name, channel, purpose, language, status, version, content, variables, created_by)
    VALUES (
      'Abandoned Cart — 24h', 'email', 'marketing', 'en', 'active', 1,
      jsonb_build_object(
        'subject', 'You left something behind 🛒',
        'html_body', '<p>Hi {first_name},</p><p>Your cart is still waiting. Come back and finish up:</p><p><a href="{checkout_url}">Complete your order</a></p><p style="font-size:12px;color:#888">If you''d rather not hear from us, <a href="{unsubscribe_url}">unsubscribe</a>.</p>',
        'text_body', 'Hi {first_name}, your cart is still waiting: {checkout_url}'),
      jsonb_build_array(
        jsonb_build_object('token','first_name','source','profile','field','display_name','fallback','there'),
        jsonb_build_object('token','checkout_url','source','event','field','checkout_url','fallback','https://legendoftoys.com')
      ),
      'system')
    RETURNING id INTO v_template_id;
  END IF;

  -- The journey header + v1 definition — idempotent on name.
  SELECT id INTO v_journey_id FROM comms.journeys WHERE name = 'Abandoned Cart' LIMIT 1;
  IF v_journey_id IS NULL THEN
    INSERT INTO comms.journeys (name, status, trigger, reenrolment, created_by)
    VALUES ('Abandoned Cart', 'draft',
            jsonb_build_object('type','event','name','checkout_started'),
            'once_while_active', 'system')
    RETURNING id INTO v_journey_id;

    INSERT INTO comms.journey_versions (journey_id, version, definition, created_by)
    VALUES (v_journey_id, 1,
      jsonb_build_object(
        'entry','wait1',
        'steps', jsonb_build_object(
          'wait1', jsonb_build_object('type','wait','duration','24 hours','next','cond1'),
          'cond1', jsonb_build_object('type','condition',
                    'check', jsonb_build_object('kind','no_event_since_enrol','event','order_placed'),
                    'if_true','send1','if_false','exit1'),
          'send1', jsonb_build_object('type','send','channel','email','purpose','marketing',
                    'templateId', v_template_id::text, 'next','exit1'),
          'exit1', jsonb_build_object('type','exit','outcome','completed')
        )),
      'system');

    UPDATE comms.journeys SET active_version = 1 WHERE id = v_journey_id;
  END IF;
END $$;
