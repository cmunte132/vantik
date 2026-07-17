import { Injectable } from '@nestjs/common';

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
      version: process.env.VERSION ?? 'unknown',
      status: 'ok',
    };
  }
}
