/**
 * This server image's build stamp.
 *
 * The same value the webapp image is stamped with when a deploy builds both, so
 * a change here is a reliable prompt for a client to go and re-check what the
 * webapp is serving. It is never used to gate a request: the client's version is
 * neither read nor enforced anywhere on this side.
 *
 * Resolution mirrors apps/webapp/build-id.js — the explicit stamp first, then
 * the version that self-hosted installs already set in .env.
 */
export const SERVER_BUILD =
  process.env.VANTIK_BUILD_ID ||
  process.env.VANTIK_COMMIT ||
  process.env.VERSION ||
  'unknown';
