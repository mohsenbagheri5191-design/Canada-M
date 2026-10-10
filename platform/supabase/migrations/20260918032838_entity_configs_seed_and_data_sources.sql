-- Describing the real tables, and turning that description into the list of
-- things a layout document is allowed to query.
--
-- The Design Studio already promises, in its own UI, that "the document never
-- carries a URL; the server resolves a source id to an endpoint, so a design
-- cannot make the app call somewhere new". Until now nothing enforced it,
-- because nothing consumed data at all.
--
-- This is the enforcement. `entity_configs` names the tables and the columns
-- that may be read; `resolve_layout` returns that list alongside the layout;
-- the app refuses any source the list does not contain. A design document that
-- asked for `org_settings` would otherwise be served to an org admin whose RLS
-- grants let them read it — and `org_settings.secrets` is in that table.

insert into public.entity_configs (table_name, display_name, feature_key, title_field, tenant_column, field_config, permissions)
values
  ('tasks', 'Tasks', null, 'title', 'organization_id',
   jsonb_build_object(
     'columns', jsonb_build_array('id','title','notes','status','priority','due_at','completed_at','labels','position','project_id','assignee_id','updated_at'),
     'fields', jsonb_build_object(
       'title',    jsonb_build_object('label','Title','type','text','required',true),
       'notes',    jsonb_build_object('label','Notes','type','textarea'),
       'status',   jsonb_build_object('label','Status','type','enum','options', jsonb_build_array('todo','in_progress','blocked','done')),
       'priority', jsonb_build_object('label','Priority','type','enum','options', jsonb_build_array('low','normal','high','urgent')),
       'due_at',   jsonb_build_object('label','Due','type','datetime'),
       'labels',   jsonb_build_object('label','Labels','type','text[]')
     )),
   jsonb_build_object('read', jsonb_build_array('app_user','designer','org_admin','super_admin'),
                      'write', jsonb_build_array('app_user','designer','org_admin','super_admin'),
                      'writableColumns', jsonb_build_array('title','notes','status','priority','due_at','completed_at','labels','position'))),

  ('notes', 'Notes', 'notes', 'title', 'organization_id',
   jsonb_build_object(
     'columns', jsonb_build_array('id','title','body','body_format','pinned','labels','project_id','task_id','updated_at'),
     'fields', jsonb_build_object(
       'title',  jsonb_build_object('label','Title','type','text','required',true),
       'body',   jsonb_build_object('label','Body','type','textarea'),
       'pinned', jsonb_build_object('label','Pinned','type','boolean'),
       'labels', jsonb_build_object('label','Labels','type','text[]')
     )),
   jsonb_build_object('read', jsonb_build_array('app_user','designer','org_admin','super_admin'),
                      'write', jsonb_build_array('app_user','designer','org_admin','super_admin'),
                      'writableColumns', jsonb_build_array('title','body','pinned','labels'))),

  ('projects', 'Projects', null, 'name', 'organization_id',
   jsonb_build_object(
     'columns', jsonb_build_array('id','key','name','description','status','colour','due_on','starts_on','owner_id','updated_at'),
     'fields', jsonb_build_object(
       'name',        jsonb_build_object('label','Name','type','text','required',true),
       'key',         jsonb_build_object('label','Key','type','text'),
       'description', jsonb_build_object('label','Description','type','textarea'),
       'status',      jsonb_build_object('label','Status','type','enum','options', jsonb_build_array('active','paused','done','archived')),
       'due_on',      jsonb_build_object('label','Due','type','date')
     )),
   jsonb_build_object('read', jsonb_build_array('app_user','designer','org_admin','super_admin'),
                      'write', jsonb_build_array('designer','org_admin','super_admin'),
                      'writableColumns', jsonb_build_array('name','description','status','colour','due_on','starts_on')))
on conflict (table_name) do update
  set display_name = excluded.display_name,
      feature_key  = excluded.feature_key,
      title_field  = excluded.title_field,
      field_config = excluded.field_config,
      permissions  = excluded.permissions;
