import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { PAGES_QUEUE } from 'modules/pages/pages.interface';

import { KnowledgeSignalsService } from './knowledge-signals.service';

/**
 * Outcome signals about knowledge, from runs and their pull requests.
 *
 * A module of its own, with nothing but the database and the pages queue, so
 * that both the run lifecycle and the GitHub integration can report to it:
 * the pages module reads repositories through the integrations, and the
 * integrations would otherwise have to import it back.
 */
@Module({
  imports: [BullModule.registerQueue({ name: PAGES_QUEUE })],
  providers: [KnowledgeSignalsService],
  exports: [KnowledgeSignalsService],
})
export class KnowledgeSignalsModule {}
