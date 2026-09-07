-- S355 fix round 1 (Task 11 review, finding 3) — the manual-clear trigger widened to fire on
-- ASSIGNMENT ITSELF, not just the null->non-null TRANSITION. An agent claiming a thread that is
-- ALREADY assigned (reassignment, or a bot session that started after assignment) previously left
-- bot_active=true, hiding the thread from the owner's pills and the Awaiting count. Agent
-- supremacy: the bot never holds a thread a human owns — any live assigned_agent_id clears the
-- rail, every time this row is written, not only on the first claim. Same function name, so the
-- existing trigger (cs_wa_threads_clear_bot_active_manual, BEFORE UPDATE) picks this up with no
-- re-creation needed.
CREATE OR REPLACE FUNCTION store.cs_clear_bot_active_manual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = store, public AS $$
BEGIN
  IF NEW.bot_active AND (
       (NEW.thread_state IS DISTINCT FROM OLD.thread_state AND NEW.thread_state IN ('closed','snoozed'))
    OR NEW.assigned_agent_id IS NOT NULL
  ) THEN
    NEW.bot_active := false;
  END IF;
  RETURN NEW;
END $$;
