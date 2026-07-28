import { Injectable } from '@nestjs/common';

import { StorageProvider } from './storage-provider.interface';
import { createStorageProvider } from './storage.registry';

/**
 * The injectable face of the registry. The choice of backend and the check on
 * its configuration live in storage.registry.ts, so a test can call them
 * without Nest.
 */
@Injectable()
export class StorageFactory {
  createStorageProvider(): StorageProvider {
    return createStorageProvider();
  }
}
