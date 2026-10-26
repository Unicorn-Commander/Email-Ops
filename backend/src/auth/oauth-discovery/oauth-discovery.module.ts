import { Module } from '@nestjs/common';
import { OAuthDiscoveryController } from './oauth-discovery.controller';
import { OAuthDiscoveryService } from './oauth-discovery.service';

@Module({
  controllers: [OAuthDiscoveryController],
  providers: [OAuthDiscoveryService],
  exports: [OAuthDiscoveryService],
})
export class OAuthDiscoveryModule {}
