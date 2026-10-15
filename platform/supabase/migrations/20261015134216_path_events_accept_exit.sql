-- The app records how long a screen was looked at with an 'exit' event when
-- the user leaves it, the only moment that duration is knowable. The CHECK
-- allowed view, action and error only, so every telemetry batch carrying an
-- exit was refused with a 400 and the whole batch was lost, views included.
--
-- Widening, not renaming: existing rows are untouched, and 'exit' is the one
-- word the schema was missing. Taps are sent as 'action', the schema's own word.
alter table public.path_events drop constraint path_events_event_check;
alter table public.path_events add constraint path_events_event_check
  check (event in ('view', 'exit', 'action', 'error'));
