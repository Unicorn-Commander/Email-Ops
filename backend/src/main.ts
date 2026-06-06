import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Behind the suite Traefik (TLS terminated at the proxy): trust the first
  // proxy hop so req.protocol/host reflect X-Forwarded-* (https), which the
  // Keycloak OAuth callback URL is built from.
  app.set('trust proxy', 1);

  // Security
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: configService.get('CORS_ORIGIN', 'http://localhost:3001'),
    credentials: true,
  });

  // Global prefix
  const apiPrefix = configService.get('API_PREFIX', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Email-Ops API')
    .setDescription(
      'The mailbox / thread surface (Stalwart-fronted) + agent-inbox of the Unicorn ' +
        'Commander suite (Phase 1 foundation).',
    )
    .setVersion('0.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('auth', 'Authentication + SSO')
    .addTag('health', 'Health check endpoints')
    .addTag('mcp', 'MCP server (the EmailOpsPort contract + agent-inbox)')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = configService.get('PORT', 3231);
  await app.listen(port, '0.0.0.0');

  logger.log(`Email-Ops API running on http://0.0.0.0:${port}/${apiPrefix}`);
  logger.log(`Swagger docs: http://0.0.0.0:${port}/${apiPrefix}/docs`);
}

bootstrap();
