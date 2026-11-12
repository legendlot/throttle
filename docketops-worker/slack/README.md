# Docket Slack app — setup (F9 R7)

The app is created and installed by a **Slack workspace admin** (spec §9.1: Afshaan). Docket's code for it
(R7) is built after the app exists; until then the `/slack/*` routes on docketops don't exist and Slack
will show "dispatch_failed" if anyone tries the command — so install it, hand over the secrets, and don't
announce it yet.

## 1. Create the app (≈ 3 minutes, admin)

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick the workspace **legend-of-toys** → **Next**.
3. Choose the **YAML** tab, delete the sample, paste the whole of
   [`docket-app-manifest.yaml`](./docket-app-manifest.yaml) → **Next** → check the summary shows
   5 bot scopes, 1 shortcut, 1 slash command → **Create**.
4. **Install to Workspace** (left menu → *Install App*) → **Allow**. If the workspace requires admin
   approval for apps, approve it in the admin console.
5. Optional: *Basic Information → Display Information* → add an app icon.

## 2. Hand over the two secrets (admin, in a terminal — never paste them in chat or Slack)

From *Install App* copy the **Bot User OAuth Token** (`xoxb-…`); from *Basic Information → App Credentials*
copy the **Signing Secret**. Then:

```bash
cd ~/Documents/Claude/05_Throttle/docketops-worker && npx wrangler secret put SLACK_DOCKET_BOT_TOKEN
```

```bash
cd ~/Documents/Claude/05_Throttle/docketops-worker && npx wrangler secret put SLACK_DOCKET_SIGNING_SECRET
```

(each prompts for the value — paste it there). On the home laptop the path is `~/Documents/00_Claude/…`.

## 3. Tell the Docket lane "Slack app is installed"

Nothing else is needed from the admin. The lane then builds R7 against this app:
- `POST /slack/interactive` — the "Add to Docket" shortcut modal, buttons (Done / Move date / Comment /
  Accept hand-off), modal submits.
- `POST /slack/commands` — `/docket add <text>` · `mine` · `propose <text>`.
- Every request is verified with the signing secret (v0 HMAC, 5-minute replay window) and accepted only from
  a Slack user mapped to an employee by work email (`docket.slack_identities`, via `users.lookupByEmail`);
  it runs as that person, `source: slack`.
- Reminders (spec §9.2, IST) go out as DMs from a docketops cron trigger.

## What the scopes are for (spec §9.1 — keep the list exactly this)

| Scope | Why |
|---|---|
| `chat:write` | post the reminder DMs and update them after a button press |
| `im:write` | open the DM with each person |
| `users:read` | read the Slack user behind a shortcut / button / command |
| `users:read.email` | map a Slack user to their Docket employee by work email |
| `commands` | the `/docket` slash command |

No event subscriptions, no channel history, no file access: the app never reads conversations. The
shortcut receives the one message it was used on, from Slack's payload.
