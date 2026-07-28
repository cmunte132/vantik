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
  CreateProductDto,
  ProductRequestParamsDto,
  UpdateProductDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { ProductsService } from './products.service';

@Controller({
  version: '1',
  path: 'products',
})
export class ProductsController {
  constructor(private products: ProductsService) {}

  @Get()
  @UseGuards(AuthGuard)
  async getProducts(@Workspace() workspace: string) {
    return await this.products.getProducts(workspace);
  }

  @Post()
  @UseGuards(AuthGuard)
  async createProduct(
    @Workspace() workspace: string,
    @Body() productData: CreateProductDto,
  ) {
    return await this.products.createProduct(productData, workspace);
  }

  // The update and delete routes name the product by id and nothing else, so
  // WorkspaceResourceGuard proves the row belongs to the caller's workspace
  // before the service touches it.
  @Post(':productId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateProduct(
    @Param() productParams: ProductRequestParamsDto,
    @Body() productData: UpdateProductDto,
  ) {
    return await this.products.updateProduct(
      productData,
      productParams.productId,
    );
  }

  @Delete(':productId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteProduct(@Param() productParams: ProductRequestParamsDto) {
    return await this.products.deleteProduct(productParams.productId);
  }
}
