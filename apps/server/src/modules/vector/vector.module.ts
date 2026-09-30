import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';

import { VectorService } from './vector.service';

@Module({
  providers: [VectorService, EmbeddingsService],
  exports: [VectorService],
})
export class VectorModule {}
