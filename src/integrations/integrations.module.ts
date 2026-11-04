import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { N8nSignatureGuard } from './n8n-signature.guard';
import { OutboxService } from './outbox.service';
import { PhotoStorageService } from './photo-storage.service';
import { SensitiveDataService } from './sensitive-data.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    N8nSignatureGuard,
    OutboxService,
    PhotoStorageService,
    SensitiveDataService,
  ],
  exports: [
    N8nSignatureGuard,
    OutboxService,
    PhotoStorageService,
    SensitiveDataService,
  ],
})
export class IntegrationsModule {}
