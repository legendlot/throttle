// M9 — Slack alerting. Same convention as throttleops (slackOps/slackTeam): a Slack
// Incoming Webhook URL in an env secret, POST { text }, fail-open. If SLACK_WEBHOOK_ALERTS
// is unset, log + return so the worker never fails a send/queue op on a misconfigured alert.
// Env var follows the throttleops SLACK_WEBHOOK_<CHANNEL> naming → #relay-alerts.
async function alert(env, message) {
  if (!env.SLACK_WEBHOOK_ALERTS) {
    console.log('[Slack:alerts]', message);
    return false;
  }
  try {
    const res = await fetch(env.SLACK_WEBHOOK_ALERTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) console.log('alert_delivery_failed', res.status);   // dead webhook must not be silent
    return res.ok;
  } catch (e) {
    console.error('[Slack:alerts] Failed to send:', e.message);
    return false;
  }
}

module.exports = { alert };
