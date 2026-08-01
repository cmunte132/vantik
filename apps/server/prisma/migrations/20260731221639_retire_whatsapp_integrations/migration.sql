-- WhatsApp and WhatsApp Business are removed: the maintainer has no use for
-- them, and neither had ever run. See ENG-89.
--
-- The seeder only ever upserts, so removing the two entries from the seed list
-- stops them being created but leaves the existing rows in place. A definition
-- row is what makes an integration appear as installable, so without this an
-- operator would still be offered a WhatsApp card whose code no longer exists,
-- and connecting it would fail at the dynamic import.
--
-- Soft-deleted rather than dropped, because a deployment elsewhere may hold
-- IntegrationAccount rows pointing at these definitions. Deleting the row
-- outright would break that foreign key; marking it deleted hides the
-- integration while leaving the history intact.
UPDATE "IntegrationDefinitionV2"
SET "deleted" = NOW()
WHERE "slug" IN ('whatsapp', 'whatsapp-business')
  AND "deleted" IS NULL;
