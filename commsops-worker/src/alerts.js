// M9 — Slack alerting. Best-effort and fail-open: if SLACK_ALERT_WEBHOOK is unset or the
// POST fails, alert() returns false and never throws, so the worker never fails a send or
// queue op because alerting is misconfigured. Wire a Slack Incoming Webhook (a new
// #relay-alerts channel or #system-updates) into the secret to turn it on.
async function alert(env, text) {
  if (!env.SLACK_ALERT_WEBHOOK) return false;
  try {
    const res = await fetch(env.SLACK_ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:satellite_antenna: *Relay* — ${text}` }),
    });
    return res.ok;
  } catch { return false; }
}

module.exports = { alert };
