import { Module } from '@nestjs/common';

import { AgentSkillController } from './agent-skill.controller';

@Module({
  controllers: [AgentSkillController],
})
export class AgentSkillModule {}
