import { Module } from '@nestjs/common';

import CompanyService from 'modules/company/company.service';
import { UsersService } from 'modules/users/users.service';

import { PeopleController } from './people.controller';
import PeopleService from './people.service';

@Module({
  controllers: [PeopleController],
  providers: [PeopleService, UsersService, CompanyService],
  exports: [PeopleService],
})
export class PeopleModule {}
