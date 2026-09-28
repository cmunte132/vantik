import { Injectable } from '@nestjs/common';

import { VANTIK_VERSION } from 'common/version';

export interface ServerInfo {
  name: string;
  version: string;
  status: 'ok';
}

@Injectable()
export class AppService {
  getInfo(): ServerInfo {
    return {
      name: 'vantik-server',
      version: VANTIK_VERSION,
      status: 'ok',
    };
  }
}
