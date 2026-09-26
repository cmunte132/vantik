import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { CompanyController } from './company.controller';
import CompanyService from './company.service';

@Module({
  controllers: [CompanyController],
  providers: [CompanyService, UsersService],
  exports: [CompanyService],
})
export class CompanyModule {}
