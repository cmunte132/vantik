-- The knowledge bank meets the product graph.
--
-- Pages can be linked to a product, a module or a capability, the things
-- documentation is most often about. Postgres adds enum values in place, so
-- existing links are untouched.
ALTER TYPE "PageLinkType" ADD VALUE IF NOT EXISTS 'PRODUCT';
ALTER TYPE "PageLinkType" ADD VALUE IF NOT EXISTS 'MODULE';
ALTER TYPE "PageLinkType" ADD VALUE IF NOT EXISTS 'CAPABILITY';

-- What sort of knowledge an entry is. Every existing entry was written as a
-- plain fact, which is what the default says.
CREATE TYPE "PageEntryKind" AS ENUM ('FACT', 'DECISION', 'CONVENTION', 'GOTCHA');

ALTER TABLE "PageEntry"
  ADD COLUMN "kind" "PageEntryKind" NOT NULL DEFAULT 'FACT',
  -- The modules an entry's scope falls in. Empty until the server resolves it:
  -- it recomputes every entry of a workspace at boot and whenever a module's
  -- repositories change, so existing rows fill themselves in.
  ADD COLUMN "moduleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
