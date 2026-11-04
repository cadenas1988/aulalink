import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PickupController } from './pickup.controller';
import { PickupService } from './pickup.service';

@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [PickupController],
  providers: [PickupService],
})
export class PickupModule {}
