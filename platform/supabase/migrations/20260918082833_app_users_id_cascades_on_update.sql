-- Accepting an invitation re-points an app_users row at the auth id Supabase
-- just minted, which is an UPDATE of a primary key. Every foreign key aimed at
-- that key was NO ACTION, so the update would be refused the moment the invited
-- person was referenced anywhere — a design pre-assigned to them, a task
-- assigned before they accepted. The invite would fail with a constraint
-- violation at the exact moment it was being accepted.
--
-- ON UPDATE CASCADE makes the re-point safe. ON DELETE is left exactly as it
-- was: what happens when a person is removed is a separate decision, already
-- made per table, and nothing here should quietly change it.

do $$
declare
  r record;
  v_delete text;
begin
  for r in
    select c.conname,
           c.conrelid::regclass::text as tbl,
           a.attname as col,
           c.confdeltype
      from pg_constraint c
      join lateral unnest(c.conkey) k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.contype = 'f'
       and c.confrelid = 'public.app_users'::regclass
       and c.confupdtype <> 'c'
  loop
    v_delete := case r.confdeltype
                  when 'c' then ' on delete cascade'
                  when 'n' then ' on delete set null'
                  when 'd' then ' on delete set default'
                  when 'r' then ' on delete restrict'
                  else ''
                end;

    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table %s add constraint %I foreign key (%I) references public.app_users(id) on update cascade%s',
      r.tbl, r.conname, r.col, v_delete);
  end loop;
end $$;

-- app_users.id also references auth.users(id); that one must NOT cascade from
-- our side, and is left alone by the filter above only if it already matches.
-- Assert the outcome rather than assuming it.
do $$
declare v_left text;
begin
  select string_agg(conname, ', ') into v_left
    from pg_constraint
   where contype = 'f' and confrelid = 'public.app_users'::regclass and confupdtype <> 'c';

  if v_left is not null then
    raise exception 'still not cascading: %', v_left;
  end if;
end $$;
