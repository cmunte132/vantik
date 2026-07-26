import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';
import { VectorModule } from 'modules/vector/vector.module';

import KnowledgeIndexService from './knowledge-index.service';
import { KnowledgeController } from './knowledge.controller';
import KnowledgeService from './knowledge.service';
import PageLinksService from './page-links.service';
import { PageEntriesController } from './page-entries.controller';
import PageEntriesService from './page-entries.service';
import { PagesController } from './pages.controller';
import { PAGES_QUEUE } from './pages.interface';
import { PagesProcessor, PagesScheduler } from './pages.processor';
import PagesService from './pages.service';

@Module({
  imports: [
    PrismaModule,
    VectorModule,
    BullModule.registerQueue({ name: PAGES_QUEUE }),
  ],
  controllers: [PagesController, PageEntriesController, KnowledgeController],
  providers: [
    PagesService,
    PageEntriesService,
    PageLinksService,
    KnowledgeService,
    KnowledgeIndexService,
    PagesScheduler,
    PagesProcessor,
    PrismaService,
    UsersService,
  ],
  exports: [PagesService, PageEntriesService, PageLinksService, KnowledgeService],
})
export class PagesModule {}
