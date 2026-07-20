# CLAUDE.md — LOT Monorepo (05_Throttle)
> Last updated: 2026-05-10

## What this repo is

Monorepo for three active LOT systems: Garage, Redline, and Throttle.
All three are Next.js static-export apps built with Turborepo.

Repo: `legendlot/throttle`
Deploy: push to `main` → GitHub Actions builds → pushes to gh-pages of target repos.

| App | URL | Target repo |
|---|---|---|
| Garage | garage.legendoftoys.com | legendlot/Stores (gh-pages) |
| Redline | redline.legendoftoys.com | legendlot/dashboard (gh-pages) |
| Throttle | throttle.legendoftoys.com | legendlot/throttle (gh-pages) |
| Depot | depot.legendoftoys.com | legendlot/depot (gh-pages) |

> Note: more apps exist than this original table lists (garage/redline/throttle + ignition/pitstop/podium/snorkel/docket/**depot**). Depot is a dispatch-only back-office app on the **shared lotopsproxy** worker (no own worker) — added Session 140. Full system map lives in the workspace-root `CORE.md`.

## Monorepo structure

```
05_Throttle/
├── apps/
│   ├── garage/        Next.js — store ops (GRN, stock, production runs, issue queue)
│   ├── redline/       Next.js — production floor (scans, QC, dispatch, hourly)
│   └── throttle/      Next.js — brand team work OS (tasks, sprints, requests)
├── packages/
│   ├── ui/            Shared components (Sidebar, Modal, Topbar, Toast, etc.)
│   ├── auth/          AuthProvider, RequireAuth, useAuth, hasPermission
│   ├── db/            garageFetch (GET), workerFetch (POST)
│   └── domain/        Shared domain constants
└── worker/            lotopsproxy source (NOT throttleops — see below)
```
> Throttle system state: `systems/throttle.md` at workspace root (relocated from `05_Throttle/THROTTLE_BUILD.md` Session 83)

## Two workers — do not confuse them

| Worker | Source | Serves | Deploy command |
|---|---|---|---|
| `lotopsproxy` | `01_worker/worker.js` (root) | Garage + Redline + Scanner | `cd 01_worker && npx wrangler deploy` |
| `throttleops` | `05_Throttle/worker/src/index.js` | Throttle only | `cd 05_Throttle/worker && npx wrangler deploy` |

When making API changes for Garage or Redline: edit `01_worker/worker.js`.
When making API changes for Throttle: edit `05_Throttle/worker/src/index.js`.

## Build commands

```bash
# Build all apps
npx turbo build

# Build one app only
npx turbo build --filter=garage
npx turbo build --filter=redline
npx turbo build --filter=throttle

# Dev server
npx turbo dev --filter=garage
```

Always run a build for the affected app before committing. Zero errors required.

## Deploy process

Both Garage and Redline auto-deploy on every push to `main` in this repo.
Throttle also auto-deploys on push to `main`.
Build time: 3-4 min. No manual trigger needed.

GitHub secret required: `NEXT_PUBLIC_LOTOPS_URL` = `https://lotopsproxy.afshaan.workers.dev`
This is passed as `NEXT_PUBLIC_WORKER_URL` in Garage and Redline deploy workflows.
Throttle uses a separate secret pointing to throttleops.

## API call conventions

- `garageFetch(action, params, session)` — GET. Auto-unwraps `{ data: value }`. For reads.
- `workerFetch(action, body, session)` — POST. Returns `{ ok, data }`. For mutations.
- `workerFetch` injects `action` into the POST body automatically: sends `{ action, ...body }`.
- Raw fetch calls that bypass workerFetch MUST include `action` in the body explicitly.
- Worker routes POSTs by `body.action`. URL `?action=` is only for GETs and login/refreshToken.

## Key rules

- Always run `git pull` before starting any work in this repo.
- Run a build after changes. Zero errors required before commit.
- Commit and push after every confirmed change.
- Never modify `wrangler.toml` without explicit permission.
- PostgREST returns numeric DB columns as strings. Always wrap with `Number()` before
  arithmetic. Always wrap integer insert values with `Math.round()`.
- Never loop await per row — batch via IN filters, array inserts, or RPCs.
  **Subrequest ceiling is 10,000 per invocation** (Paid plan; 50 is the Free-plan figure, and a
  separate 1,000 cap applies to internal services — KV/D1/R2/service bindings). Verified 2026-07-20.
- **A Worker cannot `fetch()` another Worker on the same `workers.dev` zone** — Cloudflare
  error 1042, surfacing as a 404. Cross-worker calls need a `[[services]]` binding
  (see `csops-worker/wrangler.toml`).
- Every new `store` schema table needs: `GRANT ALL ON store.{table} TO service_role`
