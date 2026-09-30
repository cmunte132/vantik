/// <reference types="vite/client" />

/** The build stamp, inlined by vite.config.ts `define`. See build-id.js. */
interface ImportMetaEnv {
  readonly VANTIK_BUILD_ID: string;
  readonly VANTIK_BUILD_COMMIT: string;
  readonly VANTIK_BUILT_AT: string;
}
