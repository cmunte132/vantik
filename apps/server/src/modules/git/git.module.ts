import { Module } from '@nestjs/common';
import { PluginsModule } from 'plugins/plugins.module';

import { CredentialsModule } from 'modules/agent-runs/credentials/credentials.module';

import { GitSourcesService } from './git-sources.service';
import { RepoMirrorService } from './repo-mirror.service';
import { GithubSource } from './sources/github.source';

/**
 * Git for every source of code: the sources, and the server's mirrors of
 * their repositories.
 */
@Module({
  // PluginsModule for the GitHub installation token, and CredentialsModule for
  // the workspace's git token.
  imports: [PluginsModule, CredentialsModule],
  providers: [GitSourcesService, RepoMirrorService, GithubSource],
  exports: [GitSourcesService, RepoMirrorService],
})
export class GitModule {}
