import { IsString } from 'class-validator';

export class ProductRequestParamsDto {
  @IsString()
  productId: string;
}
