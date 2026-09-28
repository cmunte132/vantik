-- A citation's judgment records what it judged: the words and the code.
--
-- A judge reads an entry's claim against changed code. A person may reword
-- the entry afterwards, and the gardener must not act on a judgment of the
-- old words as if it were about the new ones: the judged claim is kept as
-- the entry's content hash. And a person who puts back an entry the gardener
-- disputed has overruled that judgment of that code, which must not be
-- raised again because unrelated commits moved the repository's head: the
-- code the judge read is kept as a hash of it.
--
-- Two new nullable columns. No existing row is written: a judgment made
-- before them is read again before anything acts on it.
-- AlterTable
ALTER TABLE "PageEntryCitation" ADD COLUMN     "judgedCodeHash" TEXT,
ADD COLUMN     "judgedContentHash" TEXT;
