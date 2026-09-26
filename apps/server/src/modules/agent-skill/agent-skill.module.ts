import { Module } from '@nestjs/common';

import { AgentSkillController } from './agent-skill.controller';
import { WellKnownSkillsController } from './well-known-skills.controller';

@Module({
  controllers: [AgentSkillController, WellKnownSkillsController],
})
export class AgentSkillModule {}
