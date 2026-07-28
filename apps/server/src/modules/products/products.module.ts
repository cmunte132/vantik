import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController],
  providers: [ProductsService, UsersService],
  exports: [ProductsService],
})
export class ProductsModule {}
