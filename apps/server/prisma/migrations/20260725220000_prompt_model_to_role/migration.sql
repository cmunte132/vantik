-- Prompt.model becomes a role string ("fast" / "smart") instead of an enum of
-- model names, so reaching a new model is configuration rather than a
-- migration.
--
-- Written by hand: Prisma's generated enum-to-text migration drops and
-- recreates the column, which would discard every workspace's prompt
-- configuration. The USING clause converts in place.
ALTER TABLE "Prompt" ALTER COLUMN "model" DROP DEFAULT;

ALTER TABLE "Prompt" ALTER COLUMN "model" TYPE TEXT USING (
  CASE "model"::TEXT
    WHEN 'GPT35TURBO' THEN 'fast'
    WHEN 'LLAMA3'     THEN 'fast'
    WHEN 'GPT4TURBO'  THEN 'smart'
    WHEN 'GPT4O'      THEN 'smart'
    WHEN 'CLAUDEOPUS' THEN 'smart'
    ELSE 'fast'
  END
);

ALTER TABLE "Prompt" ALTER COLUMN "model" SET DEFAULT 'fast';

DROP TYPE "LLMModels";
