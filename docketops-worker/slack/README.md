# Docket Slack app — setup (F9 R7)

The app is created and installed by a **Slack workspace admin** (spec §9.1: Afshaan). Docket's code for it
(R7) is built after the app exists; until then only `/slack/events` exists (it answers Slack's URL check)
and Slack will show "dispatch_failed" if anyone tries the command or a shortcut — so install it, hand over the secrets, and don't
announce it yet.

## 1. Create the app (≈ 3 minutes, admin)

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick the workspace **legend-of-toys** → **Next**.
3. Choose the **YAML** tab, delete the sample, paste the whole of
   [`docket-app-manifest.yaml`](./docket-app-manifest.yaml) → **Next** → check the summary shows
   28 bot scopes, 2 shortcuts, 1 slash command, 1 unfurl domain
   (`docket.legendoftoys.com`), 5 bot events → **Create**. (Slack checks the events URL here; docketops
   answers it.)
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

## What the scopes are for — future-proofed (Afshaan, 2026-11-12)

**Why so many:** adding a scope later means an admin re-approves and reinstalls the app. Turning on a
feature those scopes already cover (event subscriptions, the Home tab, link previews, another shortcut
or `/docket` sub-command) does not. So the scopes cover every Docket use case we can foresee now; R7 itself
uses only the first five. Spec §9.1 records the wider list.

| Scope | Use case it unlocks | Used by |
|---|---|---|
| `chat:write` | reminder DMs; update a message after a button press; scheduled messages | R7 |
| `im:write` | open the DM with each person | R7 |
| `users:read` | who pressed / shortcut / commanded; their time zone | R7 |
| `users:read.email` | map a Slack user to their Docket employee by work email | R7 |
| `commands` | `/docket` (one command, sub-commands grow without a reinstall) | R7 |
| `chat:write.public` | post a team's review pack / weekly score in its public channel without inviting the bot | later |
| `chat:write.customize` | post as "Docket · Review" etc. under one app | later |
| `mpim:write` | one group DM to founders + Associates (Thursday pack, Saturday catch-up) | later |
| `channels:join` | the bot joins a public team channel it should post or listen in | later |
| `channels:read` `groups:read` `im:read` `mpim:read` | find a team's channel by name; know where a shortcut was used (incl. private) | later |
| `usergroups:read` | resolve `@design` style team handles in `/docket add …` | later |
| `team:read` | workspace name/domain for permalinks and previews | later |
| `app_mentions:read` | "@Docket add invite cards by Fri" in any channel the bot is in | later |
| `im:history` | DM the bot to capture a task; read replies under a reminder DM | later |
| `mpim:history` | the same in a group DM that includes the bot | later |
| `channels:history` `groups:history` | capture the WHOLE thread (not just one message) into a task's description — **only channels the bot has been added to** | later |
| `reactions:read` | ✅ on a reminder line marks that task done | later |
| `reactions:write` | the bot ticks the message it captured, so the thread knows | later |
| `links:read` `links:write` | paste a `docket.legendoftoys.com` task link → a preview card (status, owner, deadline) — rendered at the lowest level of anyone in the channel | later |
| `files:read` | save a file from the captured message as a task document | later |
| `files:write` | attach the review pack as a CSV/PDF to the founders' DM (an Incoming Webhook can't attach files) | later |
| `bookmarks:write` | pin a "Docket — <team>" bookmark to each team channel | later |
| `assistant:write` | Slack's AI side panel ("ask Docket what's overdue") if we turn it on | later |

**The one real trade-off — the `*:history` scopes.** They let the bot read messages in a channel *after
someone adds it to that channel* (and its own DMs). It can't read channels it isn't in, and Docket stores
nothing from a conversation unless a person runs a capture (shortcut, mention, DM). **Kept — Afshaan, 2026-11-12**: "turn this thread into a task" is the obvious
next ask, and adding them later would force a reinstall.

**Deliberately NOT included** (each would need a reinstall to add, and none has a Docket use):
- any **user-token** scope (acting as a person in Slack, `search:read`): every action runs as the bot,
  mapped to the person — no one has to OAuth individually;
- `channels:manage` / `groups:write` (create/archive/rename channels), `admin.*`, `users:write`;
- `pins:write`, `reminders:*`, `dnd:*`, `calls:*`, `emoji:read`, `remote_files:*`, `incoming-webhook`;
- Workflow Builder custom steps ("Create Docket task" as a workflow step): they need a functions block +
  an events URL in the manifest. Revisit when wanted — that one is a manifest change, not a scope.

**Event subscriptions are in from day one** (`app_mention`, `app_home_opened`, `link_shared`, `message.im`,
`reaction_added` → `/slack/events`): Slack requires them for the unfurl domain and verifies the URL at
creation, so docketops answers the handshake already and only acknowledges events until R7. Channel-message
events are NOT subscribed (they'd stream every message in a channel the bot is in) — added when thread
capture is built.

**Switched on later without a reinstall** (Slack only asks for one when a change needs a scope that isn't
granted): more events, the Home tab (a personal "my tasks" view), more `/docket` sub-commands.
