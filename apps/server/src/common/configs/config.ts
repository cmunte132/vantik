import type { Config } from './config.interface';

export const config: Config = {
  cors: {
    enabled: true,
  },
  superToken: {
    appInfo: {
      appName: 'Vantik',
      apiDomain: process.env.BACKEND_HOST,
      websiteDomain: process.env.FRONTEND_HOST,
      // Keep in sync with supertokens.service.ts, which is what actually
      // initialises SuperTokens.
      apiBasePath: '/api/auth',
      websiteBasePath: '/auth',
    },
    connectionURI: process.env.SUPERTOKEN_CONNECTION_URI,
  },
  log: {
    level: process.env.LOG_LEVEL,
    createLogFile: process.env.CREATE_LOG_FILE === 'true',
  },
};

export default (): Config => config;
