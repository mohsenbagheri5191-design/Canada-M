-- The rules engine.
--
-- Conditions are the same structured shape the renderer evaluates —
-- { all: [...] } / { any: [...] } / { not: ... } with {left, op, right} leaves,
-- left as a "$path" into the event scope. Two evaluators over one shape is a
-- risk, so the comparator list here is written to match renderer.js exactly,
-- and `rules.test` in the dashboard runs the same document against the same
-- semantics. Nothing is ever passed to a dynamic executor: the language has no
-- function calls and no way to name a table.

create or replace function private.rule_read_path(p_path text, p_scope jsonb)
returns jsonb
language sql
immutable
set search_path to ''
as $$
  select case
    when p_path is null or p_path = '' then null
    else p_scope #> string_to_array(ltrim(p_path, '$'), '.')
  end;
$$;

/** Compare two jsonb values with the renderer's operator set. */
create or replace function private.rule_compare(p_left jsonb, p_op text, p_right jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $$
declare
  l text := case when p_left is null or jsonb_typeof(p_left) = 'null' then null
                 when jsonb_typeof(p_left) = 'string' then p_left #>> '{}'
                 else p_left::text end;
  r text := case when p_right is null or jsonb_typeof(p_right) = 'null' then null
                 when jsonb_typeof(p_right) = 'string' then p_right #>> '{}'
                 else p_right::text end;
  ln numeric;
  rn numeric;
begin
  -- "is empty" treats null, the empty string and the empty array alike, which
  -- is what the renderer does and what an author means by it.
  if p_op = 'is empty' then
    return l is null or l = '' or (jsonb_typeof(p_left) = 'array' and jsonb_array_length(p_left) = 0);
  elsif p_op = 'is not empty' then
    return not (l is null or l = '' or (jsonb_typeof(p_left) = 'array' and jsonb_array_length(p_left) = 0));
  end if;

  if p_op in ('>', '>=', '<', '<=') then
    begin
      ln := l::numeric;
      rn := r::numeric;
    exception when others then
      return false; -- a non-numeric comparison is false, never an error
    end;
    return case p_op when '>' then ln > rn when '>=' then ln >= rn
                     when '<' then ln < rn else ln <= rn end;
  end if;

  return case p_op
    when '==' then l is not distinct from r
    when '!=' then l is distinct from r
    when 'contains' then coalesce(position(lower(r) in lower(l)) > 0, false)
    when 'starts with' then coalesce(lower(l) like lower(r) || '%', false)
    else true                                  -- an unknown operator does not block
  end;
end;
$$;

create or replace function private.rule_conditions_pass(p_cond jsonb, p_scope jsonb)
returns boolean
language plpgsql
stable
set search_path to ''
as $$
declare
  c jsonb;
begin
  if p_cond is null or p_cond = 'null'::jsonb or p_cond = '{}'::jsonb then
    return true;
  end if;

  if p_cond ? 'all' then
    for c in select * from jsonb_array_elements(p_cond -> 'all') loop
      if not private.rule_conditions_pass(c, p_scope) then return false; end if;
    end loop;
    return true;
  end if;

  if p_cond ? 'any' then
    for c in select * from jsonb_array_elements(p_cond -> 'any') loop
      if private.rule_conditions_pass(c, p_scope) then return true; end if;
    end loop;
    return false;
  end if;

  if p_cond ? 'not' then
    return not private.rule_conditions_pass(p_cond -> 'not', p_scope);
  end if;

  return private.rule_compare(
    case when jsonb_typeof(p_cond -> 'left') = 'string' and (p_cond ->> 'left') like '$%'
         then private.rule_read_path(p_cond ->> 'left', p_scope)
         else p_cond -> 'left' end,
    coalesce(p_cond ->> 'op', '=='),
    case when jsonb_typeof(p_cond -> 'right') = 'string' and (p_cond ->> 'right') like '$%'
         then private.rule_read_path(p_cond ->> 'right', p_scope)
         else p_cond -> 'right' end);
end;
$$;

/** Fill {{path}} placeholders from the scope. Text only; never SQL. */
create or replace function private.rule_interpolate(p_text text, p_scope jsonb)
returns text
language plpgsql
stable
set search_path to ''
as $$
declare
  v_out text := coalesce(p_text, '');
  m text[];
  v jsonb;
begin
  for m in select regexp_matches(v_out, '\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}', 'g') loop
    v := private.rule_read_path(m[1], p_scope);
    v_out := replace(v_out, '{{' || m[1] || '}}',
                     coalesce(case when jsonb_typeof(v) = 'string' then v #>> '{}' else v::text end, ''));
  end loop;
  return v_out;
end;
$$;

revoke execute on function private.rule_read_path(text, jsonb) from public, anon, authenticated;
revoke execute on function private.rule_compare(jsonb, text, jsonb) from public, anon, authenticated;
revoke execute on function private.rule_conditions_pass(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function private.rule_interpolate(text, jsonb) from public, anon, authenticated;
