import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { IssuesModule } from 'modules/issues/issues.module';
import { UsersService } from 'modules/users/users.service';

import { CyclesAutomationService } from './cycles-automation.service';
import { CyclesController } from './cycles.controller';
import { CYCLES_QUEUE } from './cycles.interface';
import { CyclesProcessor, CyclesScheduler } from './cycles.processor';
import { CyclesService } from './cycles.service';

@Module({
  imports: [
    PrismaModule,
    IssuesModule,
    BullModule.registerQueue({ name: CYCLES_QUEUE }),
  ],
  controllers: [CyclesController],
  providers: [
    CyclesService,
    CyclesAutomationService,
    CyclesScheduler,
    CyclesProcessor,
    PrismaService,
    UsersService,
  ],
  exports: [CyclesService, CyclesAutomationService],
})
export class CyclesModule {}
