import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';
import { VectorModule } from 'modules/vector/vector.module';

import KnowledgeIndexService from './knowledge-index.service';
import { KnowledgeController } from './knowledge.controller';
import KnowledgeService from './knowledge.service';
import { PageEntriesController } from './page-entries.controller';
import PageEntriesService from './page-entries.service';
import { PagesController } from './pages.controller';
import PagesService from './pages.service';

@Module({
  imports: [PrismaModule, VectorModule],
  controllers: [PagesController, PageEntriesController, KnowledgeController],
  providers: [
    PagesService,
    PageEntriesService,
    KnowledgeService,
    KnowledgeIndexService,
    PrismaService,
    UsersService,
  ],
  exports: [PagesService, PageEntriesService, KnowledgeService],
})
export class PagesModule {}
