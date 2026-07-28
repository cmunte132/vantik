-- Adds the three agent values that the ModelName enum already declares.
--
-- schema.prisma lists AgentRun, AgentRunEvent and AgentRunIteration, and no
-- migration ever added them. That was true by accident on the machine where the
-- axis was written, because its database had run the agents branch and already
-- held the values. It is false everywhere else: a database built from this
-- migration history has an enum the schema does not match, so `prisma migrate
-- diff` reports drift and any write of one of these values fails.
--
-- The values come first and the models come later, on purpose. A sync action
-- naming a value the enum does not declare stops every read of SyncAction — not
-- only the rows of that one model — so the enum has to be ahead of the tables
-- rather than behind them.
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRun';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRunEvent';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRunIteration';
