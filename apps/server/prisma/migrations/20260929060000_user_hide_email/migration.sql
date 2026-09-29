-- A person can keep their email address out of the app's navigation.
ALTER TABLE "User" ADD COLUMN "hideEmail" BOOLEAN NOT NULL DEFAULT false;
