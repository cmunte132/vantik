import { Module } from '@nestjs/common';

import { CredentialsService } from './credentials.service';

/**
 * The workspace's sealed credentials, on their own.
 *
 * A module of its own so that the git sources can read the git token without
 * importing the agent runs, which import the git sources. Provided here only:
 * the service reseals legacy rows when the module starts, and two providers
 * would do that twice.
 */
@Module({
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
