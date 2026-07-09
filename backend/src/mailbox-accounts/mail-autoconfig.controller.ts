import { BadRequestException, Controller, Get, Header, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { DeviceConfigService } from './device-config.service';

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) ? email : null;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

@ApiTags('mail-autoconfig')
@Controller()
export class MailAutoconfigController {
  constructor(
    private readonly deviceConfig: DeviceConfigService,
    private readonly admin: MailEngineAdminPort,
    private readonly config: ConfigService,
  ) {}

  @Get('.well-known/autoconfig/mail/config-v1.1.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({ summary: 'Public Thunderbird autoconfig settings for hosted domains.' })
  async thunderbirdWellKnown(@Query('emailaddress') emailaddress: string) {
    return this.thunderbirdXml(emailaddress);
  }

  @Get('mail/config-v1.1.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({ summary: 'Public Thunderbird autoconfig vhost settings for hosted domains.' })
  async thunderbirdVhost(@Query('emailaddress') emailaddress: string) {
    return this.thunderbirdXml(emailaddress);
  }

  @Post('autodiscover/autodiscover.xml')
  @ApiOperation({ summary: 'Public Outlook autodiscover settings for hosted domains.' })
  async autodiscover(@Req() req: Request, @Res() res: Response) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const email = normalizeEmail(body.match(/<EMailAddress>([^<]+)<\/EMailAddress>/i)?.[1]);
    if (!email) throw new BadRequestException('Autodiscover request must include EMailAddress.');
    await this.assertHostedDomain(domainOf(email));
    const xml = this.deviceConfig.buildAutodiscoverXml(email);
    res.set({ 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(xml)) });
    res.send(xml);
  }

  private async thunderbirdXml(emailaddress: string): Promise<string> {
    const email = normalizeEmail(emailaddress);
    if (!email) throw new BadRequestException('emailaddress must be a valid email address.');
    const domain = domainOf(email);
    await this.assertHostedDomain(domain);
    return this.deviceConfig.buildThunderbirdAutoconfigXml(domain);
  }

  private async assertHostedDomain(domain: string): Promise<void> {
    const normalized = normalizeDomain(domain);
    if (!normalized) throw new BadRequestException('Invalid domain.');

    const configured = (this.config.get<string>('MAIL_AUTOCONFIG_DOMAINS') ?? '')
      .split(',')
      .map((d) => normalizeDomain(d))
      .filter((d): d is string => !!d);
    if (configured.includes(normalized)) return;

    const hosted = await this.admin.listDomains();
    if (!hosted.some((d) => normalizeDomain(d.domain) === normalized)) {
      throw new BadRequestException('Domain is not hosted here.');
    }
  }
}
