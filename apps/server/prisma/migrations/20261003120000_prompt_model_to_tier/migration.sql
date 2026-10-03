-- Prompt.model names a tier instead of a role (ENG-215). Label and module
-- suggestions are decisions; every other prompt runs on the default tier.
-- Converted in place, so no workspace loses its prompt configuration.
ALTER TABLE "Prompt" ALTER COLUMN "model" SET DEFAULT 'default';

UPDATE "Prompt"
SET "model" = CASE
  WHEN "name" IN ('IssueLabels', 'ModuleClassifier') THEN 'decisions'
  ELSE 'default'
END;
