-- The body as it stood before a change, so an agent's rewrite can be diffed
-- and reverted. Nullable: history rows that did not touch the body have none,
-- and every row written before this migration has none either.
ALTER TABLE "PageHistory" ADD COLUMN "previousBody" TEXT;
