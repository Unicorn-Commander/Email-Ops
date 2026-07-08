import { ConfigService } from '@nestjs/config';
import { DeviceConfigService } from './device-config.service';

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('DeviceConfigService', () => {
  it('builds owner connection settings from mailbox overrides with James defaults', () => {
    const svc = new DeviceConfigService(
      makeConfig({
        JAMES_JMAP_URL: 'https://mail.unicorncommander.ai/jmap',
        JAMES_IMAP_PORT: '993',
        JAMES_IMAP_SECURITY: 'ssl',
        JAMES_SMTP_PORT: '587',
        JAMES_SMTP_SECURITY: 'starttls',
      }),
    );

    const settings = svc.buildConnectionSettings({
      emailAddress: 'aaron@example.test',
      displayName: 'Aaron',
      imapHost: null,
      imapPort: null,
      smtpHost: 'smtp.example.test',
      smtpPort: 2587,
      jmapUrl: null,
    });

    expect(settings).toMatchObject({
      email: 'aaron@example.test',
      username: 'aaron@example.test',
      imap: { host: 'mail.unicorncommander.ai', port: 993, security: 'ssl' },
      smtp: { host: 'smtp.example.test', port: 2587, security: 'starttls' },
      jmap: { url: 'https://mail.unicorncommander.ai/jmap' },
    });
  });

  it('builds a valid Apple mobileconfig shape without embedded password keys', () => {
    const svc = new DeviceConfigService(makeConfig({ JAMES_JMAP_URL: 'https://mail.example.test/jmap' }));
    const settings = svc.buildConnectionSettings({
      emailAddress: 'aaron@example.test',
      displayName: 'Aaron S',
      imapHost: null,
      imapPort: null,
      smtpHost: null,
      smtpPort: null,
      jmapUrl: null,
    });

    const xml = svc.buildAppleMobileconfig(settings);

    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain('<string>com.apple.mail.managed</string>');
    expect(xml).toContain('<key>IncomingMailServerHostName</key><string>mail.example.test</string>');
    expect(xml).toContain('<key>IncomingMailServerPortNumber</key><integer>993</integer>');
    expect(xml).toContain('<key>OutgoingMailServerPortNumber</key><integer>587</integer>');
    expect(xml).toContain('<key>IncomingMailServerUsername</key><string>aaron@example.test</string>');
    expect(xml).toContain('<key>OutgoingPasswordSameAsIncoming</key><true/>');
    expect(xml).not.toContain('IncomingPassword');
    expect(xml).not.toContain('OutgoingPassword</key>');
  });

  it('builds manual, Thunderbird, and Autodiscover payloads with canonical settings', () => {
    const svc = new DeviceConfigService(makeConfig({ JAMES_JMAP_URL: 'https://mail.example.test/jmap' }));
    const settings = svc.buildConnectionSettings({
      emailAddress: 'user@example.test',
      displayName: null,
      imapHost: null,
      imapPort: null,
      smtpHost: null,
      smtpPort: null,
      jmapUrl: null,
    });

    expect(svc.buildManualSettings(settings)).toHaveLength(5);
    expect(svc.buildThunderbirdAutoconfigXml('example.test')).toContain('<hostname>mail.example.test</hostname>');
    expect(svc.buildAutodiscoverXml('user@example.test')).toContain('<LoginName>user@example.test</LoginName>');
  });
});
