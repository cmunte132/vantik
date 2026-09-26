import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, UsersService],
  exports: [ProductsService],
})
export class ProductsModule {}
