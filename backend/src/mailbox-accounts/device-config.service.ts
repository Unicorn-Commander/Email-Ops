import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

export type MailSecurity = 'ssl' | 'starttls' | 'none';

export interface DeviceConnectionSettings {
  email: string;
  displayName: string | null;
  username: string;
  imap: { host: string; port: number; security: MailSecurity };
  smtp: { host: string; port: number; security: MailSecurity };
  jmap: { url: string | null };
  notes: string[];
}

export interface ManualClientSettings {
  client: string;
  steps: string[];
  fields: {
    imapHost: string;
    imapPort: number;
    imapSecurity: MailSecurity;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: MailSecurity;
    username: string;
  };
}

function cleanHost(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim()).hostname || null;
  } catch {
    return raw.trim().replace(/^https?:\/\//, '').split('/')[0] || null;
  }
}

function cleanSecurity(raw: string | null | undefined, fallback: MailSecurity): MailSecurity {
  const value = raw?.trim().toLowerCase();
  return value === 'ssl' || value === 'starttls' || value === 'none' ? value : fallback;
}

function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function boolKey(key: string, value: boolean): string {
  return `<key>${key}</key><${value ? 'true' : 'false'}/>`;
}

function stringKey(key: string, value: string | number | null | undefined): string {
  return `<key>${key}</key><string>${escapeXml(value)}</string>`;
}

function integerKey(key: string, value: number): string {
  return `<key>${key}</key><integer>${value}</integer>`;
}

@Injectable()
export class DeviceConfigService {
  constructor(private readonly config: ConfigService) {}

  canonicalSettings() {
    const jmapUrl = this.config.get<string>('JAMES_JMAP_URL')?.trim() || 'https://mail.unicorncommander.ai/jmap';
    const jmapHost = cleanHost(jmapUrl) ?? 'mail.unicorncommander.ai';
    const imapHost = cleanHost(this.config.get<string>('JAMES_IMAP_HOST')) ?? jmapHost;
    const smtpHost = cleanHost(this.config.get<string>('JAMES_SMTP_HOST')) ?? imapHost;
    return {
      imapHost,
      imapPort: Number(this.config.get<string>('JAMES_IMAP_PORT') ?? 993) || 993,
      imapSecurity: cleanSecurity(this.config.get<string>('JAMES_IMAP_SECURITY'), 'ssl'),
      smtpHost,
      smtpPort: Number(this.config.get<string>('JAMES_SMTP_PORT') ?? 587) || 587,
      smtpSecurity: cleanSecurity(this.config.get<string>('JAMES_SMTP_SECURITY'), 'starttls'),
      jmapUrl,
    };
  }

  buildConnectionSettings(row: {
    emailAddress: string;
    displayName: string | null;
    imapHost: string | null;
    imapPort: number | null;
    smtpHost: string | null;
    smtpPort: number | null;
    jmapUrl: string | null;
  }): DeviceConnectionSettings {
    const defaults = this.canonicalSettings();
    return {
      email: row.emailAddress,
      displayName: row.displayName,
      username: row.emailAddress,
      imap: {
        host: row.imapHost?.trim() || defaults.imapHost,
        port: row.imapPort ?? defaults.imapPort,
        security: defaults.imapSecurity,
      },
      smtp: {
        host: row.smtpHost?.trim() || defaults.smtpHost,
        port: row.smtpPort ?? defaults.smtpPort,
        security: defaults.smtpSecurity,
      },
      jmap: { url: row.jmapUrl?.trim() || defaults.jmapUrl },
      notes: [
        'Use your full email address as the username.',
        'Use the mail app-password generated from Email-Ops, not your login password.',
        'Apple configuration profiles are unsigned, so Apple will show an Unsigned warning during install.',
      ],
    };
  }

  buildAppleMobileconfig(settings: DeviceConnectionSettings): string {
    const localpart = settings.email.split('@')[0]?.replace(/[^a-zA-Z0-9.-]/g, '-') || 'mailbox';
    const domain = settings.email.split('@')[1] || 'Email-Ops';
    const accountName = settings.displayName || settings.email;
    const payloadIdentifier = `ai.unicorncommander.emailops.${localpart}`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  ${stringKey('PayloadType', 'Configuration')}
  ${integerKey('PayloadVersion', 1)}
  ${stringKey('PayloadIdentifier', payloadIdentifier)}
  ${stringKey('PayloadUUID', randomUUID())}
  ${stringKey('PayloadDisplayName', `${settings.email} Email`)}
  ${stringKey('PayloadDescription', `Adds the ${settings.email} IMAP/SMTP account. No password is embedded; the device will prompt for the mail app-password.`)}
  ${stringKey('PayloadOrganization', 'Unicorn Commander')}
  <key>PayloadContent</key>
  <array>
    <dict>
      ${stringKey('PayloadType', 'com.apple.mail.managed')}
      ${integerKey('PayloadVersion', 1)}
      ${stringKey('PayloadIdentifier', `${payloadIdentifier}.mail`)}
      ${stringKey('PayloadUUID', randomUUID())}
      ${stringKey('EmailAccountType', 'EmailTypeIMAP')}
      ${stringKey('EmailAddress', settings.email)}
      ${stringKey('EmailAccountName', accountName)}
      ${stringKey('EmailAccountDescription', domain)}
      ${stringKey('IncomingMailServerAuthentication', 'EmailAuthPassword')}
      ${stringKey('IncomingMailServerHostName', settings.imap.host)}
      ${integerKey('IncomingMailServerPortNumber', settings.imap.port)}
      ${boolKey('IncomingMailServerUseSSL', settings.imap.security === 'ssl')}
      ${stringKey('IncomingMailServerUsername', settings.username)}
      ${stringKey('OutgoingMailServerAuthentication', 'EmailAuthPassword')}
      ${stringKey('OutgoingMailServerHostName', settings.smtp.host)}
      ${integerKey('OutgoingMailServerPortNumber', settings.smtp.port)}
      ${boolKey('OutgoingMailServerUseSSL', settings.smtp.security === 'ssl' || settings.smtp.security === 'starttls')}
      ${stringKey('OutgoingMailServerUsername', settings.username)}
      ${boolKey('OutgoingPasswordSameAsIncoming', true)}
      ${boolKey('SMIMEEnabled', false)}
    </dict>
  </array>
</dict>
</plist>
`;
  }

  buildManualSettings(settings: DeviceConnectionSettings): ManualClientSettings[] {
    const fields = {
      imapHost: settings.imap.host,
      imapPort: settings.imap.port,
      imapSecurity: settings.imap.security,
      smtpHost: settings.smtp.host,
      smtpPort: settings.smtp.port,
      smtpSecurity: settings.smtp.security,
      username: settings.username,
    };
    return [
      {
        client: 'Apple Mail',
        steps: [
          'Open Mail settings and add a new Other Mail Account.',
          'Enter your name, email address, and generated mail password.',
          'When asked for server details, use the IMAP and SMTP fields below.',
        ],
        fields,
      },
      {
        client: 'Outlook',
        steps: [
          'Add an account and choose IMAP when Outlook asks for the account type.',
          'Use the generated mail password for both incoming and outgoing authentication.',
          'If Outlook separates classic and new setup, choose manual/advanced setup.',
        ],
        fields,
      },
      {
        client: 'Thunderbird',
        steps: [
          'Add an existing mail account.',
          'Thunderbird should discover these settings automatically for hosted domains.',
          'If discovery does not complete, choose Manual config and enter the fields below.',
        ],
        fields,
      },
      {
        client: 'Android / Gmail app',
        steps: [
          'Add another account and choose Other.',
          'Enter your email address, choose Personal (IMAP), and enter the generated mail password.',
          'Confirm the incoming and outgoing server fields below.',
        ],
        fields,
      },
      {
        client: 'Generic IMAP',
        steps: [
          'Choose IMAP for incoming mail and SMTP submission for outgoing mail.',
          'Use password authentication and your full email address as the username.',
          'Enter the generated mail password anywhere the client asks for a password.',
        ],
        fields,
      },
    ];
  }

  buildThunderbirdAutoconfigXml(domain: string): string {
    const defaults = this.canonicalSettings();
    return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${escapeXml(domain)}">
    <domain>${escapeXml(domain)}</domain>
    <displayName>Unicorn Commander Mail</displayName>
    <displayShortName>Unicorn Mail</displayShortName>
    <incomingServer type="imap">
      <hostname>${escapeXml(defaults.imapHost)}</hostname>
      <port>${defaults.imapPort}</port>
      <socketType>${defaults.imapSecurity === 'ssl' ? 'SSL' : defaults.imapSecurity === 'starttls' ? 'STARTTLS' : 'plain'}</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${escapeXml(defaults.smtpHost)}</hostname>
      <port>${defaults.smtpPort}</port>
      <socketType>${defaults.smtpSecurity === 'ssl' ? 'SSL' : defaults.smtpSecurity === 'starttls' ? 'STARTTLS' : 'plain'}</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;
  }

  buildAutodiscoverXml(email: string): string {
    const defaults = this.canonicalSettings();
    return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${escapeXml(defaults.imapHost)}</Server>
        <Port>${defaults.imapPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>${defaults.imapSecurity === 'ssl' ? 'on' : 'off'}</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${escapeXml(defaults.smtpHost)}</Server>
        <Port>${defaults.smtpPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>${defaults.smtpSecurity === 'ssl' || defaults.smtpSecurity === 'starttls' ? 'on' : 'off'}</SSL>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
  }
}
