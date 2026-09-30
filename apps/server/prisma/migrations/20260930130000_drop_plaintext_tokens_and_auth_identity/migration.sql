BEGIN;

-- Confirm the key copy before the migration removes the legacy tables.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'webauthn_credentials'
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM "public"."webauthn_credentials" c
            LEFT JOIN "vantik"."AuthIdentity" ai ON c.user_id = ai."supertokensUserId"
            LEFT JOIN "vantik"."PasskeyCredential" p ON p."id" = c.id
            WHERE ai."userId" IS NULL
                OR p."userId" IS DISTINCT FROM ai."userId"
                OR p."publicKey" IS DISTINCT FROM substring(c.public_key FROM (19 + (get_byte(c.public_key, 16) * 256 + get_byte(c.public_key, 17))))
                OR p."rpId" IS DISTINCT FROM c.rp_id
        ) THEN
            RAISE EXCEPTION 'Cannot remove legacy auth tables: a WebAuthn credential has no matching account and key';
        END IF;
    END IF;
END $$;

-- The server keeps only the hash of a personal access token. The migration
-- 20260930120000_in_server_auth filled "tokenHash" for every token that had a
-- value, so the plaintext column and the unused "jwt" column can go.

-- A row without a hash cannot authenticate a request, so remove it.
DELETE FROM "vantik"."PersonalAccessToken" WHERE "tokenHash" IS NULL;

DROP INDEX IF EXISTS "vantik"."PersonalAccessToken_name_userId_token_key";
DROP INDEX IF EXISTS "vantik"."PersonalAccessToken_token_idx";
DROP INDEX IF EXISTS "vantik"."PersonalAccessToken_tokenHash_idx";

ALTER TABLE "vantik"."PersonalAccessToken"
    DROP COLUMN "token",
    DROP COLUMN "jwt",
    ALTER COLUMN "tokenHash" SET NOT NULL;

CREATE UNIQUE INDEX "PersonalAccessToken_tokenHash_key"
    ON "vantik"."PersonalAccessToken"("tokenHash");

-- The CLI collects its token once, through the authorization code.
ALTER TABLE "vantik"."AuthorizationCode" ADD COLUMN "pendingToken" TEXT;

-- AuthIdentity mapped SuperTokens user ids to accounts. The passkey copy in
-- 20260930120000_in_server_auth was its last reader.
DROP TABLE "vantik"."AuthIdentity";

-- SuperTokens 12.0.7 creates these tables. Keep all other public tables and extensions.
-- Drop the tables as one group. Do not use CASCADE on objects outside this group.
DROP TABLE IF EXISTS
    "public"."activity_log",
    "public"."all_auth_recipe_users",
    "public"."app_id_to_user_id",
    "public"."apps",
    "public"."bulk_import_users",
    "public"."dashboard_user_sessions",
    "public"."dashboard_users",
    "public"."emailpassword_pswd_reset_tokens",
    "public"."emailpassword_user_to_tenant",
    "public"."emailpassword_users",
    "public"."emailverification_tokens",
    "public"."emailverification_verified_emails",
    "public"."jwt_signing_keys",
    "public"."key_value",
    "public"."oauth_clients",
    "public"."oauth_logout_challenges",
    "public"."oauth_m2m_tokens",
    "public"."oauth_sessions",
    "public"."passwordless_codes",
    "public"."passwordless_devices",
    "public"."passwordless_user_to_tenant",
    "public"."passwordless_users",
    "public"."primary_user_tenants",
    "public"."recipe_user_account_infos",
    "public"."recipe_user_tenants",
    "public"."role_permissions",
    "public"."roles",
    "public"."saml_claims",
    "public"."saml_clients",
    "public"."saml_relay_state",
    "public"."session_access_token_signing_keys",
    "public"."session_info",
    "public"."tenant_configs",
    "public"."tenant_first_factors",
    "public"."tenant_required_secondary_factors",
    "public"."tenant_thirdparty_provider_clients",
    "public"."tenant_thirdparty_providers",
    "public"."tenants",
    "public"."thirdparty_user_to_tenant",
    "public"."thirdparty_users",
    "public"."totp_used_codes",
    "public"."totp_user_devices",
    "public"."totp_users",
    "public"."user_last_active",
    "public"."user_metadata",
    "public"."user_roles",
    "public"."userid_mapping",
    "public"."webauthn_account_recovery_tokens",
    "public"."webauthn_credentials",
    "public"."webauthn_generated_options",
    "public"."webauthn_user_to_tenant",
    "public"."webauthn_users";

COMMIT;
