# Podium — Title, Level, Team (draft for Afshaan, 2026-11-13)

> Afshaan 2026-11-13: what someone does is described by three things. **Title** = what we call them (custom,
> anything). **Level** = where they sit on one hierarchy ladder (Associate … Director, VP), the same in every
> team. **Team** = the org unit (department). He agreed to retire the job-role catalogue ("Yes, draft the ladder").
> Status: DRAFT. Ladder accepted by Afshaan 2026-11-13 ("Largely looks right") with Senior Director added. Per-person
> confirmation (title, level, team, reports-to) runs in the Google Sheet "LOT org structure: title, level, team and
> reporting (Nov 2026)" (`1VL87uVuHG7-wGu7SRVurhWWpNo5JJTTmty7OMmEpd7Y`): Vinay and Mohit confirm their reporting
> lines, Afshaan the rest. The same sheet holds the draft pay band per level (figures live only there, not in this repo).
> Build starts once the sheet is confirmed; Podium is then loaded from it.

## Why (measured 2026-11-13, 64 active people)

- Five places say what someone does: `employees.job_title` (57 of 64 filled, 52 distinct), `employees.job_role_id` →
  `job_roles` (38 roles bundling title + level + department + salary range + JD + KPIs; 35 people linked; 0 roles
  carry a salary range, 0 KPIs, 0 openings use one), `job_roles.level` (9 values, reachable only through a role),
  `employees.department_id` (62 of 64), and the free-text `designation` on openings and offers.
- 16 people's title disagrees with their role (a Founder's Office manager on the Factory "Manager" role, an intern
  on a Sales "Associate" role). Seven roles are just "Associate" with a department attached.
- "Band" already means the salary range in Podium (opening budgets, offer above-band approval). The hierarchy is
  therefore called **Level** unless Afshaan prefers otherwise.

## The ladder (draft)

| Code | Level | Notes |
|---|---|---|
| L0 | Intern | Every intern, whatever the team. Matches `employment_type = intern`. |
| L1 | Associate | Includes "Executive", "Officer", craft titles (designer, videographer, artist) at entry. |
| L2 | Senior Associate | Includes floor supervisors (draft — see Q1). |
| L3 | Assistant Manager | |
| L4 | Manager | |
| L5 | Senior Manager | |
| L6 | Associate Director | |
| L7 | Director | |
| L8 | Senior Director | Added by Afshaan 2026-11-13. |
| L9 | VP | |
| L10 | Founder | The two co-founders. |

"Lead", "Supervisor", "Head", "EIR" are words in a **title**, not levels. Managing people is not a level either:
an L2 supervisor can run a line, an L4 can have no reports.

## Draft rules for the first assignment

1. Intern employment type, or "Intern" in the title → L0.
2. The title names a level ("Associate", "Senior Associate", "Assistant Manager", "Manager", "Sr/Senior … Manager")
   → that level. The title beats the old job role when they disagree (flagged for review).
3. Supervisor titles → L2.
4. Craft or entry titles with no level word (designer, videographer, artist, officer, executive, admin, QC) → L1;
   L2 if they manage someone.
5. Blank title → no level until the title is filled.

## What changes in Podium (after review)

- `podium.levels` (code, name, rank, active) seeded with the ladder; `employees.level_id`; `openings.level_id`.
  The offer letter's designation = the opening's title (unchanged mechanism, now a deliberate rule).
- People page + edit form: Title, Level, Team. Job role hidden. `job_roles` kept read-only for history, then dropped
  once nothing reads it (KPIs, the opening band pre-fill and the role JD are its only readers).
- Google Directory sync unchanged: title → title, team → department. Level stays in Podium.
- Pay band per level (drafted in the sheet): one band per level for every team, adjacent bands overlap, specialist
  roles sit in the top half. Once agreed it pre-fills a new opening's band from its level; above-band offers keep the
  existing approval. The name "band" stays with pay; the hierarchy is "Level".

## Open questions for Afshaan

- Q1. Floor supervisors at L2 (Senior Associate), or L1?
- Q2. The Business Head & EIR: L7 Director or L8 VP?
- Q3. Keep "Level" as the name, or call it "Band" and rename the salary one "pay range"?
- Q4. ~~Anything missing from the ladder?~~ Senior Director added 2026-11-13.
