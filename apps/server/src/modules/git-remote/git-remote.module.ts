import { Module } from '@nestjs/common';

import { CredentialsModule } from 'modules/agent-runs/credentials/credentials.module';
import { GitModule } from 'modules/git/git.module';

import { GitRemoteController } from './git-remote.controller';
import { GitRemoteService } from './git-remote.service';

/**
 * The connections to git hosts. `GitModule` gives the source, and
 * `CredentialsModule` keeps the token of each connection.
 */
@Module({
  imports: [GitModule, CredentialsModule],
  controllers: [GitRemoteController],
  providers: [GitRemoteService],
})
export class GitRemoteModule {}
