# Jarvis — Project Handover

> Purpose: hand a fresh session everything needed to set up "Jarvis" and continue from where we left off.
> Status: **design + research phase. No code written yet.** Decisions below are agreed unless marked OPEN.
> Owner: afshaan@legendoftoys.com · Branch: `claude/jarvis-pi-assistant-mn5g89` (throttle + Cloudfare repos)
> Last updated: 2026-06-09

---

## 0. How to use this file

Read sections 1–4 first (vision + decisions). Section 5 is the prior-art research. Section 6 is what's
still undecided — **start the next session by resolving those with the user.** Section 7 is the proposed
architecture; section 8 is the concrete next steps; section 9 is reference facts you'll need.

The user wanted to **talk through setup before building** — honour that. Do not jump to scaffolding code
until the OPEN questions in §6 are answered.

---

## 1. What we're building

**Jarvis** = an always-on personal executive assistant for Afshaan, running on a **Raspberry Pi at home**,
that he talks to over **Telegram**. It manages tasks, gives morning briefings, and (later) touches
calendar/email/Slack. The brain is **Claude**.

The thing that makes it more than a toy Jarvis: it integrates with **LOT's internal task system, Docket**,
which is about to become the org-wide source of truth for tasks. So Jarvis is effectively a **head on top of
Docket** — not a standalone to-do list. This org integration is the differentiator; no off-the-shelf
assistant does it (see §5).

Scope framing agreed: **build the brain/persona as personal-to-Afshaan now**, but put genuinely reusable
capabilities (task rollups, "my day") as endpoints on the shared worker so a future org-wide assistant can
reuse them. Don't over-engineer for multi-user yet.

---

## 2. Context discovered about the codebase

The repo CLAUDE.md is **stale** — it says "three active systems / two workers." Reality (verified this session):

- The monorepo has **8 apps**: `docket, garage, ignition, pitstop, podium, redline, snorkel, throttle`.
- Packages: `auth, db, domain, ui`.
- **Docket** (`apps/docket/`) is "ready but not launched" — the org-wide task app. It already has a
  **roles + spaces permission model**: routes under `apps/docket/src/app/(auth)/` are
  `admin / roles / spaces / dashboard / tasks / scratchpad`. Lib files: `docketopsFetch.js`, `tasks.js`,
  `nav.js`, `format.js`, `hotkeys.js`, `mathEval.js`, `chrome.js`.
- **Docket has its own Cloudflare worker, `docketops`**, at `https://docketops.afshaan.workers.dev`.
  - Client: `apps/docket/src/lib/docketopsFetch.js` → `docketopsGet(action, params, session)` (GET reads,
    unwraps `{data}`) and `docketopsPost(action, body, session)` (POST writes).
  - **Auth: `Authorization: Bearer <access_token>` (JWT)** — same shape as the other LOT `*ops` workers.
  - Routing is on `action` (query param for GET, injected into body for POST). Env var:
    `NEXT_PUBLIC_DOCKETOPS_URL`.
- So there are **more than two workers** now: `lotopsproxy` (Garage/Redline/Scanner),
  `throttleops` (Throttle), `docketops` (Docket), and at least `podiumops` is referenced too.
  **The CLAUDE.md "two workers" table should be updated** when we touch it.

### Tooling visible in the session's environment (Afshaan's ecosystem)
MCP servers connected for this account: **Slack, Gmail, Google Drive, Meta Ads, GitHub.** This is the EA's
real world — eventually Jarvis will want Slack + Gmail + Drive, not just calendar. Google Workspace +
Slack + Meta Ads is the stack.

### OPEN / to-verify in codebase
- **Where is the `docketops` worker source?** Not located this session. Other workers live at
  `01_worker/worker.js` (root) and `05_Throttle/worker/src/index.js`. Find docketops' source before adding
  assistant endpoints. (Note: this repo is `legendlot/throttle`; the lotopsproxy worker lives in the
  separate `legendlot/Cloudfare` repo as `worker.js`.)
- **How does `docketops` issue / refresh tokens?** We need a way to mint a long-lived credential for a
  non-interactive Pi. Check login/refreshToken handling in the worker. This is the gating unknown for the
  auth design (§3, §6).
- Docket's tasks data model (columns, statuses, spaces schema) — read `apps/docket/src/lib/tasks.js` and the
  worker's task actions before writing any task tooling.

---

## 3. Decisions made (agreed)

1. **Identity: Jarvis is its own scoped principal in Docket — NOT a god token.**
   Afshaan explicitly refused to put a personal full-access token on a home Pi. Create a dedicated
   `jarvis` (or `assistant`) user in Docket's roles/spaces model, granted only the spaces/permissions it
   needs. Clean audit trail ("Jarvis did X on your behalf"), revocable, scopable.

2. **Autonomy level: autonomous on low-risk Docket operations.**
   Reading, creating, and updating tasks inside Docket is internal and low-risk → **act autonomously, report
   after.** Reserve a confirmation step for genuinely destructive or **outbound/external** actions (deleting,
   emailing/messaging external people, calendar invites to others) — to be implemented later.

3. **Brain on the Pi; actions go through the existing `*ops` workers, not direct to Supabase.**
   Jarvis is just another authenticated client of `docketops` (and later throttleops/lotopsproxy). This
   reuses the real permission model instead of bypassing it, and stays consistent with LOT architecture.

4. **Model: Claude via the Anthropic API (metered key), NOT a flat subscription seat.**
   - Tier models: **Haiku 4.5** for routine parsing/classification, **Sonnet 4.6** for normal conversation /
     task ops, **Opus 4.8** only for genuinely hard planning.
   - **Prompt caching** on the stable prefix (persona + tool schemas + recent memory) — biggest cost lever.
   - **Set a hard monthly spend cap in the Anthropic Console** → removes the "looking over my shoulder"
     anxiety without paying a flat seat fee.
   - Rationale: at personal scale, metered API with caching is **cheaper than a $100+/mo Max seat**
     (estimate ~$5–20/mo, see §9), and the cap makes it safe. Also: the subscription/Claude-Code "seat"
     route stops being a flat-rate advantage after **2026-06-15**, when subscription `claude -p` agent usage
     bills at standard API rates (confirmed via OpenClaw docs, §5).

5. **Memory: local SQLite on the Pi for Phase 1.** Private, simple, no worker round-trips. Promote to a
   Supabase table only if briefings need to be readable server-side.

6. **Proactivity: Pi-side scheduler (systemd timers / cron), event-driven model calls.**
   The Pi is always-on, so the 7am briefing and any "watch for X" polling run as Pi timers — no need to burn
   worker cron or fight the 50-subrequest Cloudflare limit. **Critical cost rule: the Pi does cheap work
   (polling, cron, trigger detection) WITHOUT calling the model; only invoke Claude when there's an actual
   decision to reason about or Afshaan messages it.** A model "thinking loop" is what would cause the
   couple-dollars-a-day fear; event-driven design avoids it.

7. **Channel: Telegram** (long-poll → no inbound ports / NAT holes needed on the home Pi).

8. **Network topology:** Pi behind home NAT, all outbound HTTPS (docketops, Anthropic, Google, Telegram
   long-poll). Persistent process via systemd. Secrets in a locked-down store on the Pi (not plaintext env).

---

## 4. Security posture (agreed direction)

A box at home that can act on the org's task system is a real target. Decisions/notes:
- Scope the Jarvis Docket principal tightly (only needed spaces).
- Store the Pi's long-lived credential securely; rotate it.
- **Treat task content as untrusted input** — prompt-injection defense matters once Jarvis can write to
  Docket. Borrow OpenClaw's "SkillSpector"-style idea: a policy gate that runs before acting (see §5).
- Confirmation gate on destructive/outbound actions (see decision #2).

---

## 5. Prior-art research (what's already out there)

Three mature open-source "Jarvis-style" assistants were reviewed. **All three converge on the same
scaffolding we chose** (messaging gateway, cron/heartbeat proactivity, persistent memory, MCP tools,
model-agnostic). None integrate with an org task system — that's our bespoke part.

### OpenClaw — closest fit for a Claude-native build (viral: ~9k→60k stars)
- Self-hosted, `npm i -g openclaw`, runs on Mac/Win/Linux. Decentralized — context/skills live locally.
- **Model-agnostic; first-class Anthropic (Claude) support.** Default model `anthropic/claude-opus-4-8`.
- **Proactivity:** cron jobs + "heartbeats" (periodic check-ins) + background tasks.
- **Messaging gateway:** WhatsApp, Telegram, Discord, Slack, Signal, iMessage.
- **Security:** ships "SkillSpector" for hidden-instruction / agentic-risk detection; policy-first gate.
- **How it reaches Claude (two modes — confirms our §3.4 analysis):**
  1. **API key (recommended for always-on hosts):** `openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"`.
     Usage-based billing. Their docs explicitly recommend API key for "long-lived gateway hosts, shared
     automation, predictable production spend" — a Pi is exactly that.
  2. **Claude Code login (subscription/"seat"):** `openclaw onboard` → choose Claude CLI; reuses an existing
     Claude Code OAuth login on the host. **Breaks in containers** (Podman/Docker don't mount `~/.claude`),
     so API key is mandatory if containerized.
  - Billing note from their docs: subscription `claude -p` drew from a separate monthly Agent SDK credit
    pool **until 2026-06-15**, then meters at standard API rates. → the seat's flat-rate edge is going away.
- Docs: https://docs.openclaw.ai/providers/anthropic · https://openclaw.ai/

### OpenJarvis (Stanford Scaling Intelligence Lab) — best if you wanted local-first
- Local-first, runs on-device; cloud "only when truly necessary." Hardware-aware over Ollama / vLLM /
  llama.cpp / Apple Foundation Models; model catalog Qwen/Gemma/GPT-OSS/Granite. `jarvis init` auto-detects.
- **Proactivity:** built-in cron scheduler. Headline example is literally "every morning at 7am, pull my
  calendar, check email, prepare a briefing" — our exact use case.
- **MCP-native** tools + A2A. Memory: semantic indexing over local notes/docs. 26+ messaging channels.
- Targets consumer hardware (small local models = Pi-class). Repo: https://github.com/open-jarvis/OpenJarvis ·
  https://scalingintelligence.stanford.edu/blogs/openjarvis/

### Hermes Agent (NousResearch/hermes-agent, Feb 2026) — best memory + self-improving skills
- Self-hosted, one-curl install (Linux/macOS/WSL2). **6 deploy backends:** local, Docker, SSH, Daytona,
  Singularity, Modal (serverless ones hibernate cheaply — moot for an always-on Pi).
- Single gateway → 20+ messaging platforms.
- **Most sophisticated memory:** SQLite FTS5 cross-session recall + LLM summarization + Honcho user
  modeling; agent-curated memory with periodic nudges (its proactivity mechanism).
- **Novel — autonomous skill creation:** after solving a hard problem it writes a reusable skill doc and
  self-improves it; uses the open `agentskills.io` standard.
- **How it reaches Claude — the catch:** built around Nous Portal / OpenRouter / OpenAI / any
  OpenAI-compatible endpoint. **No native Anthropic provider** → Claude only via **OpenRouter** (a
  middleman with its own billing/markup) or an OpenAI-compatible proxy. You'd **lose** native
  `ANTHROPIC_API_KEY`, the Claude Code login, clean prompt caching, and the Console spend cap. So Hermes is
  the wrong base for a Claude-native build, but great if model-promiscuous / local.
- Repo: https://github.com/NousResearch/hermes-agent · https://hermes-agent.nousresearch.com/docs/

### What to borrow regardless of stack
- **Gateway + heartbeat scheduler + persistent-memory** patterns (all three).
- **SkillSpector-style injection/policy gate** before acting (OpenClaw) — important once Jarvis writes to Docket.
- **Autonomous skill creation / agentskills.io** (Hermes) — a Phase-2 capability: Jarvis learns reusable
  "how to do X in Docket" skills that compound over time.

### Build vs adopt
OpenClaw is the closest template and could be prototyped on directly. But the realistic plan is **borrow
their proven scaffolding (gateway, scheduler, memory) and build the Docket integration + scoped-auth as the
bespoke core.** That's the value none of them provide.

---

## 6. OPEN questions — resolve these with the user first next session

1. **Expected usage volume** → sets the spend cap ($10 vs $30) and whether model tiering matters.
   How many interactions/day? Do you want proactive briefings + nudges (adds scheduled model calls)?
2. **docketops token model** (codebase unknown, §2): how does the worker issue/refresh tokens, and can it
   mint a long-lived/non-expiring service token for the Jarvis principal? This gates the auth implementation.
3. **Launch channel scope:** which integrations at v1? Agreed lean: **Google Calendar + Docket tasks** first;
   Slack/Gmail/Drive later. Confirm.
4. **Persona / identity:** name (keep "Jarvis"?), voice/tone, and voice (audio) — later or never?
5. **Build base:** prototype on OpenClaw vs. build bespoke on the Claude Agent SDK from the start?
   (Recommendation: spike OpenClaw to feel the UX, but plan the real thing on the Agent SDK so the Docket
   tooling and scoped auth are first-class.)

---

## 7. Proposed architecture (concrete, for when OPEN items are settled)

```
            Telegram (long-poll)
                  │
        ┌─────────▼─────────┐     systemd timers (cron):
        │   Jarvis on Pi    │◄──── 7am briefing, "watch for X" polling
        │  (Agent SDK loop) │      (cheap; NO model call unless decision needed)
        └───┬───────┬───────┘
            │       │
   local SQLite     │ HTTPS (Bearer JWT, scoped jarvis principal)
   (memory:         ▼
   convos +     docketops worker ──► Supabase (Docket tasks/spaces)
   facts)           ▲
            (later) throttleops / lotopsproxy / Google Calendar / Slack / Gmail
            │
            ▼
     Anthropic API (key + Console spend cap)
     tiered: Haiku 4.5 → Sonnet 4.6 → Opus 4.8
     prompt caching on stable prefix
```

- **Brain:** Claude Agent SDK loop on the Pi. Tools = thin wrappers over `docketopsGet/Post` actions, plus
  (later) Calendar/Slack/Gmail.
- **Reusable capability endpoints** (e.g. "my day" rollup) live on `docketops` so a future org assistant
  reuses them.
- **Proactivity:** Pi timers detect triggers cheaply; only escalate to a model call when reasoning is needed.

---

## 8. Concrete next steps for the next session

1. Resolve §6 OPEN questions with the user (especially usage volume + token model).
2. In code: locate the **docketops worker source**; read its auth (login/refreshToken) and task actions;
   read `apps/docket/src/lib/tasks.js` for the task data model.
3. Decide the **service-credential mechanism** for the Jarvis principal (long-lived token + rotation).
4. Create the **Jarvis principal** in Docket (roles/spaces) with least-privilege grants.
5. Decide build base (OpenClaw spike vs Agent SDK bespoke) per §6.5.
6. Stand up a minimal loop: Telegram in → Claude → one `docketops` read tool → reply. Then add task
   create/update. Then the 7am briefing timer.
7. Add the **injection/policy gate** before any write action.
8. Update the stale **CLAUDE.md worker table** (8 apps, docketops/podiumops workers) when touching it.

---

## 9. Reference facts

### Anthropic model pricing (per 1M tokens, as of this session)
| Model | ID | Input | Output | Context |
|---|---|---|---|---|
| Opus 4.8 | `claude-opus-4-8` | $5.00 | $25.00 | 1M |
| Sonnet 4.6 | `claude-sonnet-4-6` | $3.00 | $15.00 | 1M |
| Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 | 200K |

- **Prompt caching:** cache reads ≈ 0.1×, writes ≈ 1.25× (5-min TTL) / 2× (1-hr TTL). Min cacheable prefix:
  4096 tokens (Opus 4.8 / Haiku 4.5), 2048 (Sonnet 4.6). Caching is a **prefix match** — keep the system
  prompt frozen; never interpolate timestamps/UUIDs into the prefix.
- **Default to streaming** for long outputs; adaptive thinking (`thinking:{type:"adaptive"}`) for hard tasks;
  `output_config.effort` (low/medium/high/xhigh/max) tunes depth/cost.

### Cost estimate (personal scale, ~30 interactions/day)
- Sonnet for everything + caching ≈ **~$0.50/day (~$15/mo)**.
- Tier routine half to Haiku ≈ **~$5–8/mo**. Opus only occasionally.
- Conclusion: metered API + caching + a Console spend cap beats a $100+/mo Max seat for this scale.

### LOT infrastructure
- Docket worker: `docketops` @ `https://docketops.afshaan.workers.dev` · env `NEXT_PUBLIC_DOCKETOPS_URL`.
- Auth pattern: `Authorization: Bearer <access_token>` (JWT); route on `action`.
- Client lib: `apps/docket/src/lib/docketopsFetch.js`.
- Other workers: `lotopsproxy` (in `legendlot/Cloudfare` repo, `worker.js`),
  `throttleops` (`05_Throttle/worker/src/index.js`). Cloudflare **50-subrequest limit** per invocation.
- PostgREST returns numeric columns as strings → wrap reads with `Number()`, insert ints with `Math.round()`.

### Source links (research)
- OpenClaw: https://openclaw.ai/ · https://docs.openclaw.ai/providers/anthropic
- OpenJarvis: https://github.com/open-jarvis/OpenJarvis · https://scalingintelligence.stanford.edu/blogs/openjarvis/
- Hermes: https://github.com/NousResearch/hermes-agent · https://hermes-agent.nousresearch.com/docs/

---

*End of handover. Next session: start at §6.*
