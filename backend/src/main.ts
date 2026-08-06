import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { tenancyEnabled } from './common/workspace/feature-flags';

async function bootstrap() {
  // Register the body parsers ourselves so we can lift the default ~100 KB JSON cap:
  // a compose body carries bodyHtml with inline data-URI images (attachments travel
  // separately as blob refs), which easily exceeds 100 KB and would otherwise 413
  // before reaching the handler. Both webhooks (Postmark @Body JSON, Twilio token-auth
  // urlencoded) read the PARSED body, so no raw-body route is affected.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const isProduction = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

  // Fail CLOSED: a production deploy must run with multi-tenant isolation ON
  // (EMAIL_OPS_TENANCY_ENABLED=true, paired with the NOBYPASSRLS app DATABASE_URL).
  // Booting prod with tenancy OFF would drop the workspace fence — refuse to start
  // rather than serve cross-tenant. Non-prod (dev) is unaffected.
  if (isProduction && !tenancyEnabled()) {
    logger.error(
      'Refusing to boot: NODE_ENV=production but EMAIL_OPS_TENANCY_ENABLED is not true. ' +
        'Multi-tenant isolation must be ON in production. Set EMAIL_OPS_TENANCY_ENABLED=true ' +
        '(and point DATABASE_URL at the NOBYPASSRLS email_ops_app role).',
    );
    throw new Error('tenancy-required-in-production');
  }

  // Graceful shutdown: drain in-flight work + run onModuleDestroy hooks (Prisma
  // disconnects, timers cleared) on SIGTERM/SIGINT.
  app.enableShutdownHooks();

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
  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      { path: '.well-known/autoconfig/mail/config-v1.1.xml', method: RequestMethod.GET },
      { path: 'mail/config-v1.1.xml', method: RequestMethod.GET },
      { path: 'autodiscover/autodiscover.xml', method: RequestMethod.POST },
    ],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger documentation — DEV ONLY. Never expose the full API surface + schema
  // on a production deploy (recon aid); gate it behind non-production.
  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('Email-Ops API')
      .setDescription(
        'The mailbox / thread surface (Apache James-fronted) + agent-inbox of the Unicorn ' +
          'Commander suite.',
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
  }

  const port = configService.get('PORT', 3231);
  await app.listen(port, '0.0.0.0');

  logger.log(`Email-Ops API running on http://0.0.0.0:${port}/${apiPrefix}`);
  if (!isProduction) logger.log(`Swagger docs: http://0.0.0.0:${port}/${apiPrefix}/docs`);
}

bootstrap();
