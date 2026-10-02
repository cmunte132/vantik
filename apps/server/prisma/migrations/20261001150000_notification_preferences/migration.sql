-- AlterTable
ALTER TABLE "vantik"."User" ADD COLUMN "notificationPreferences" JSONB NOT NULL DEFAULT '{}';
