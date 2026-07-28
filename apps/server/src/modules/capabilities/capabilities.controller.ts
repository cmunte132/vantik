import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CapabilityRequestParamsDto,
  CreateCapabilityDto,
  UpdateCapabilityDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { CapabilitiesService } from './capabilities.service';

@Controller({
  version: '1',
  path: 'capabilities',
})
export class CapabilitiesController {
  constructor(private capabilities: CapabilitiesService) {}

  @Get()
  @UseGuards(AuthGuard)
  async getCapabilities(@Workspace() workspace: string) {
    return await this.capabilities.getCapabilities(workspace);
  }

  // The body names the modules that hold the code, so the guard runs on create
  // as well as on update.
  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createCapability(
    @Workspace() workspace: string,
    @Body() capabilityData: CreateCapabilityDto,
  ) {
    return await this.capabilities.createCapability(capabilityData, workspace);
  }

  @Post(':capabilityId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateCapability(
    @Param() capabilityParams: CapabilityRequestParamsDto,
    @Body() capabilityData: UpdateCapabilityDto,
  ) {
    return await this.capabilities.updateCapability(
      capabilityData,
      capabilityParams.capabilityId,
    );
  }

  @Delete(':capabilityId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteCapability(
    @Param() capabilityParams: CapabilityRequestParamsDto,
  ) {
    return await this.capabilities.deleteCapability(
      capabilityParams.capabilityId,
    );
  }
}
