import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PatsController } from './pats.controller';
import { PatService } from './pat.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { KeycloakStrategy } from './strategies/keycloak.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { KeycloakBrokerService } from './keycloak-broker.service';

@Module({
  imports: [
    WorkspaceModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN', '1d'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, PatsController],
  providers: [
    AuthService,
    JwtStrategy,
    KeycloakStrategy,
    KeycloakBrokerService,
    PatService,
    JwtAuthGuard,
  ],
  exports: [AuthService, JwtModule, JwtAuthGuard, KeycloakBrokerService, PatService],
})
export class AuthModule {}
