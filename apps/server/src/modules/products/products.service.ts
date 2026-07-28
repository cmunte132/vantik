import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
      (candidate) => this.keyTaken(workspaceId, candidate),
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

  /**
   * Updates a product, and finds a free key when the caller renames it.
   *
   * The create path has always done this. Update did not, and a rename on to a
   * key another product holds reached the unique index and came back as a 500
   * with a constraint name in it.
   */
  async updateProduct(updateProductDto: UpdateProductDto, productId: string) {
    const current = await this.prisma.product.findFirst({
      where: { id: productId, deleted: null },
      select: { workspaceId: true, key: true },
    });

    if (!current) {
      throw new NotFoundException({
        message: `Product ${productId} not found`,
      });
    }

    const requested = updateProductDto.key
      ? toKey(updateProductDto.key, 'product')
      : undefined;

    const key =
      requested && requested !== current.key
        ? await uniqueKey(requested, (candidate) =>
            this.keyTaken(current.workspaceId, candidate),
          )
        : undefined;

    return await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...updateProductDto,
        ...(key ? { key } : {}),
      },
    });
  }

  /**
   * Reports whether a key is in use, counting the deleted rows too.
   *
   * The unique index covers every row and not only the live ones, so a key that
   * a deleted product holds is still a key this workspace cannot reuse.
   */
  private async keyTaken(workspaceId: string, key: string): Promise<boolean> {
    return (
      (await this.prisma.product.count({ where: { workspaceId, key } })) > 0
    );
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
