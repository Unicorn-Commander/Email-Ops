import { Controller, Get, Options, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { OAuthDiscoveryService, PROTECTED_RESOURCE_PATH } from './oauth-discovery.service';

/** Public RFC 9728 metadata; this controller is intentionally outside auth. */
@Controller()
@SkipThrottle()
export class OAuthDiscoveryController {
  constructor(private readonly discovery: OAuthDiscoveryService) {}

  @Get(PROTECTED_RESOURCE_PATH.slice(1))
  getRootMetadata(@Req() request: Request, @Res() response: Response): void {
    this.sendMetadata(request, response);
  }

  @Get(`${PROTECTED_RESOURCE_PATH.slice(1)}/api/v1/mcp`)
  getMcpMetadata(@Req() request: Request, @Res() response: Response): void {
    this.sendMetadata(request, response);
  }

  @Options(PROTECTED_RESOURCE_PATH.slice(1))
  optionsRoot(@Res() response: Response): void {
    this.sendOptions(response);
  }

  @Options(`${PROTECTED_RESOURCE_PATH.slice(1)}/api/v1/mcp`)
  optionsMcp(@Res() response: Response): void {
    this.sendOptions(response);
  }

  private sendMetadata(request: Request, response: Response): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.removeHeader('Access-Control-Allow-Credentials');
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.json(this.discovery.getMetadata(request));
  }

  private sendOptions(response: Response): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.removeHeader('Access-Control-Allow-Credentials');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.status(204).send();
  }
}
