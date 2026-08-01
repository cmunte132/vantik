-- `scheduleId` held the id trigger.dev returned when a schedule was registered
-- through its HTTP API. trigger.dev is optional and is not in the compose
-- stack, so the column was a foreign key into a service that, on a default
-- deployment, was never running: the schedule was registered nowhere and the
-- action fired never.
--
-- Schedules are Bull repeatable jobs now, keyed by the ActionSchedule id
-- itself, so there is no second identifier to keep. See ENG-89.
ALTER TABLE "ActionSchedule" DROP COLUMN IF EXISTS "scheduleId";
