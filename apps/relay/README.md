# apps/relay — Relay (CX comms orchestration)

> **Status: NOT yet scaffolded.** Only brand assets are staged here ahead of the Phase-0 app scaffold.
> Authoritative design: [`docs/superpowers/specs/2026-06-25-relay-foundation-design.md`](../../docs/superpowers/specs/2026-06-25-relay-foundation-design.md).

Relay is LOT's in-house customer-communications orchestration platform (email · SMS · WhatsApp)
replacing Bitespeed — a Next.js static-export app on the shared `@throttle/*` kit, served at
`relay.legendoftoys.com`, backed by the `commsops` worker + `comms` schema. The app itself is built
in Phase 1 (engine-first, email-first).

## Brand

| Token | Hex | Role |
|---|---|---|
| Relay Yellow | `#F2CD1A` | primary / `--accent` |
| Ink | `#282828` | dark / `--ink` / surface text |
| Signal Red | `#DE2A2A` | accent-2 / highlight |

Logo = a relay baton mid-pass with a forward chevron (the message being relayed onward).

`public/` holds the favicon set (`favicon.svg`, `favicon.png` 512, `apple-touch-icon.png` 180,
+ `relay-16/32/48/64/180/512.png`). The AppLauncher reads `/favicon.png`; the Phase-0 scaffold
wires these into the Next.js `app/` head + manifest.
