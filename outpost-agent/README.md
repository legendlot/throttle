# Outpost print agent

Prints the vendor floor's labels from Outpost: the batch and EAN labels on every pack, the CTN carton label, and
the 13 mm UPC QR sticker sheets after a mint. It runs on each bench laptop (bench TE244), and on whichever PC
drives the sticker printers. It holds **no database key**: it is an enrolled Outpost device, and its own key
(`device.json`) signs every request to `outpostops`.

## Set up one agent
1. Install Node 20+. Copy this folder onto the laptop. On Windows, run `npm install` to get the printer module.
2. Copy `config.example.json` to `config.json`:
   - `label_printer`: `windows:<exact printer name>` for the bench TE244. Leave it out on a sticker-only PC.
   - `sticker_printer`: the 300-dpi sticker printer (`windows:<name>` or `tcp:<ip>:9100`). Leave it out on a
     plain bench. Set `stickers.*` (`across`, `gap_x_mm`, `gap_y_mm`, `left_mm`) to match the roll.
   - `file:./prints` writes `.prn` files instead of printing, for a dry run.
3. In Depot → Outpost → Vendors & Devices, LOT creates an **agent** enrolment code. The bench number is the bench
   whose labels this agent prints; leave it empty for a sticker-only agent. Then run:
   `node agent.mjs enrol <8-digit code>`
4. Check alignment with `node agent.mjs sample batch_label`. The same works for `ean_label`, `ctn_label` and
   `upc_stickers`.
5. Run `node agent.mjs run` as a service that restarts on boot (NSSM or Task Scheduler on Windows).

## What it guarantees
- **Each job is leased to one agent:** 60 s for a label, 180 s for a sticker sheet. The agent reports each job
  exactly once:
  - `printed`
  - `not_printed`: nothing reached the printer. The job goes back in the queue and fails after 5 tries.
  - `unknown`: the printer took some bytes and then errored.
- **A report the agent can't deliver is saved** to `pending-reports.json` and retried before the agent claims
  anything new, including after a restart.
- **A lease that runs out becomes "outcome unknown"**, never a silent reprint. A supervisor resolves it on the
  floor app as reprint (same job), "it printed", or cancel.
- **A label superseded while it was printing** is flagged `late_print`. This happens when a unit is unpacked, or
  a carton changes and gets a new label version. Throw that label away.

`device.json` is the agent's identity, so keep it private. If a laptop is lost, LOT revokes the device in Depot.
