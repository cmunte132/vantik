import { Module } from '@nestjs/common';

import CompanyService from 'modules/company/company.service';
import PeopleService from 'modules/people/people.service';
import { UsersService } from 'modules/users/users.service';

import SupportService from './support.service';

@Module({
  controllers: [],
  providers: [SupportService, UsersService, PeopleService, CompanyService],
  exports: [SupportService],
})
export class SupportModule {}
