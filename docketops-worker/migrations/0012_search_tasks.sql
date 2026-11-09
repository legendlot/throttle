-- 0012_search_tasks.sql — F5 cross-space search (spec 2026-11-09-docket-functionality.md §F5)
--
-- ⌘K used to search only the rows the open page had loaded (one space of 58). This RPC
-- searches every task the caller could OPEN, across spaces, and returns at most p_limit.
--
-- ── Visibility = getTask's gate, exactly ────────────────────────────────────
--   · a private space: the caller must own it or be a member (RULE-DOCKET-003 — admins and
--     view_all included). The worker passes those space ids from accessibleSpaces(), so
--     p_member_space_ids is the whole private-space allowance; p_view_all does NOT widen it
--     (unlike programs_for_user, whose p_view_all skips membership).
--   · General (p_default_space_id): canSeeTask — view_all, owner, assignee, creator, own
--     department, or collaborator.
--   · non-recurring (templates live on Checklist), unarchived.
-- The parent crumb (parent_task_no / parent_title) comes only from a parent that passes the
-- SAME gate, via the `vis` CTE — a sub-task you can see must not reveal a parent you can't.
--
-- ── Matching ────────────────────────────────────────────────────────────────
--   rank 0  task_no = 'DKT-'||p_num                (p_num = the worker's DKT-number parse)
--   rank 1  task_no starts with 'DKT-'||p_num
--   rank 2  title starts with the whole query
--   rank 3  every whitespace term appears in the title (any order) — ILIKE, escaped. A term is
--           also tried against task_no only if it holds a digit: "dk"/"dkt"/"t-" would otherwise
--           match all 1,170 searchable tasks through their 'DKT-' prefix.
--   rank 4  typo fallback: word_similarity(query, title) ≥ 0.4, queries ≥ 4 chars, and ONLY when
--           nothing ranked 0–3 (else it adds noise: 'sop qc' pulled 'RCA on Part Code - SOP Change').
--           0.4 measured 2026-11-09: 'chekclist'→Checklist 0.43 (12/12 real), 'packging'→Packaging 0.58
--           (16/22 real). It does NOT separate noise cleanly — 'shopfy' 3/10 real, noise up to 0.57 —
--           so rank 4 sorts by similarity and is a last resort, never mixed with exact hits.
-- Order: rank, open before done/abandoned, similarity, most recently touched.
-- 1,193 tasks on 2026-11-09 — a seq scan; no index needed at this size.
--
-- Additive + idempotent. Executable by service_role only, like every docket RPC.

begin;

create or replace function docket.search_tasks(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid,
  p_q text, p_num text default null, p_limit int default 20
)
returns table(
  id uuid, task_no text, title text, status text, priority text,
  space_id uuid, space_name text, parent_task_id uuid, parent_task_no text, parent_title text,
  owner_employee_id uuid, deadline timestamptz, revised_deadline timestamptz, match_rank int
)
language sql
stable security definer
set search_path to 'docket', 'public', 'extensions'
as $function$
  with q as (
    select lower(btrim(coalesce(p_q, ''))) as raw
  ), qq as (
    select raw,
      case when p_num ~ '^[0-9]{1,7}$' then p_num end as num,   -- digits only: it goes into a LIKE
      -- ILIKE-escape (\ % _) once, for the prefix test and each term
      replace(replace(replace(raw, '\', '\\'), '%', '\%'), '_', '\_') as esc,
      (select coalesce(array_agg(replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')), '{}')
         from (select w from unnest(regexp_split_to_array(raw, '\s+')) w where w <> '' limit 8) s) as terms
    from q
  ), vis as (
    select t.* from docket.tasks t
    where t.is_recurring = false
      and t.archived_at is null
      and (
        t.space_id = any(coalesce(p_member_space_ids, '{}'))
        or (
          t.space_id = p_default_space_id and (
            p_view_all
            or t.owner_employee_id = p_employee
            or t.assignee_employee_id = p_employee
            or t.created_by_user_id = p_user
            or (p_dept is not null and t.department_id = p_dept)
            or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
          )
        )
      )
  ), scored as (
    select m.*,
      case
        when qq.num is not null and m.task_no = 'DKT-' || qq.num then 0
        when qq.num is not null and m.task_no like 'DKT-' || qq.num || '%' then 1
        when qq.esc <> '' and m.title ilike qq.esc || '%' then 2
        when cardinality(qq.terms) > 0 and not exists (
          select 1 from unnest(qq.terms) w
          where not (m.title ilike '%' || w || '%' or (w ~ '[0-9]' and m.task_no ilike '%' || w || '%'))
        ) then 3
        when length(qq.raw) >= 4 and word_similarity(qq.raw, lower(m.title)) >= 0.4 then 4
        else 9
      end as rnk,
      case when length(qq.raw) >= 4 then word_similarity(qq.raw, lower(m.title)) else 0 end as sim
    from vis m, qq
    where qq.raw <> '' or qq.num is not null
  )
  select s.id, s.task_no, s.title, s.status, s.priority,
         s.space_id, sp.name, s.parent_task_id, p.task_no, p.title,
         s.owner_employee_id, s.deadline, s.revised_deadline, s.rnk
  from scored s
  join docket.spaces sp on sp.id = s.space_id
  left join vis p on p.id = s.parent_task_id
  where s.rnk < 4 or (s.rnk = 4 and not exists (select 1 from scored x where x.rnk < 4))
  order by s.rnk, (s.status in ('done', 'abandoned')), s.sim desc, coalesce(s.updated_at, s.created_at) desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$function$;

revoke all on function docket.search_tasks(uuid, uuid, uuid, boolean, uuid[], uuid, text, text, int) from public, anon, authenticated;
grant execute on function docket.search_tasks(uuid, uuid, uuid, boolean, uuid[], uuid, text, text, int) to service_role;

commit;
