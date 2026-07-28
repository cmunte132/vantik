import { BadRequestException, Injectable } from '@nestjs/common';
import { CreateProductDto, UpdateProductDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { toKey, uniqueKey } from 'common/product-axis';

// A product that nobody has given a status to is one the company ships now.
const DEFAULT_PRODUCT_STATUS = 'active';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async getProducts(workspaceId: string) {
    return await this.prisma.product.findMany({
      where: { workspaceId, deleted: null },
      orderBy: { name: 'asc' },
    });
  }

  async createProduct(createProductDto: CreateProductDto, workspaceId: string) {
    const key = await uniqueKey(
      toKey(createProductDto.key ?? createProductDto.name, 'product'),
      async (candidate) =>
        (await this.prisma.product.count({
          where: { workspaceId, key: candidate, deleted: null },
        })) > 0,
    );

    return await this.prisma.product.create({
      data: {
        ...createProductDto,
        key,
        status: createProductDto.status ?? DEFAULT_PRODUCT_STATUS,
        workspace: { connect: { id: workspaceId } },
      },
    });
  }

  async updateProduct(updateProductDto: UpdateProductDto, productId: string) {
    return await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...updateProductDto,
        ...(updateProductDto.key
          ? { key: toKey(updateProductDto.key, 'product') }
          : {}),
      },
    });
  }

  /**
   * Deletes a product, and refuses while it still owns a module.
   *
   * A module must have exactly one owner, so there is nowhere for the modules of
   * a deleted product to go. The database says the same thing with a check
   * constraint. Asking the caller to move the modules first is the only answer
   * that keeps every module owned, and it is the answer a person can act on.
   */
  async deleteProduct(productId: string) {
    const modules = await this.prisma.module.findMany({
      where: { ownerProductId: productId, deleted: null },
      select: { name: true },
    });

    if (modules.length > 0) {
      throw new BadRequestException({
        message:
          `This product owns ${modules.length} module(s): ` +
          `${modules.map((module) => module.name).join(', ')}. ` +
          'Give each one a new owner, then delete the product.',
      });
    }

    // A link carries no authority, so a module that only links to this product
    // keeps working. The id still has to leave the list: a product is deleted
    // softly, so nothing drops the id for us, and one left behind renders as a
    // chip for a product that is gone.
    const linked = await this.prisma.module.findMany({
      where: { linkedProductIds: { has: productId }, deleted: null },
      select: { id: true, linkedProductIds: true },
    });

    await Promise.all(
      linked.map((module) =>
        this.prisma.module.update({
          where: { id: module.id },
          data: {
            linkedProductIds: module.linkedProductIds.filter(
              (id) => id !== productId,
            ),
          },
        }),
      ),
    );

    return await this.prisma.product.update({
      where: { id: productId },
      data: { deleted: new Date().toISOString() },
    });
  }
}
