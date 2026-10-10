-- The enum options in entity_configs were written from memory and did not match
-- the table's own CHECK constraints: projects allow planning/active/on_hold/
-- done/cancelled, and tasks have a `review` status. App Data would have offered
-- an admin a value the database refuses, and the error would have surfaced as a
-- failed save with a constraint name in it.
--
-- The options now come from the constraints. That is still two places, but the
-- copy is at least correct, and a mismatch is now a one-line fix rather than a
-- redesign.

update public.entity_configs
   set field_config = jsonb_set(field_config, '{fields,status,options}',
         jsonb_build_array('planning','active','on_hold','done','cancelled'))
 where table_name = 'projects';

update public.entity_configs
   set field_config = jsonb_set(field_config, '{fields,status,options}',
         jsonb_build_array('todo','in_progress','blocked','review','done'))
 where table_name = 'tasks';
