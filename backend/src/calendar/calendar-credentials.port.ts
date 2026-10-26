import { Injectable } from '@nestjs/common';
import { CalendarCredential, CalendarCredentialMailbox } from './calendar.types';

/**
 * Credential lookup is deliberately a port. Email-Ops currently has no safe
 * server-side resolver for the mailbox password that Davis/IMAP accepts, so a
 * production default must fail closed instead of borrowing a user password or
 * logging a secret. The your-mail-host app-key bridge can replace this provider.
 */
export abstract class CalendarCredentialsPort {
  abstract resolve(
    workspaceId: string,
    mailbox: CalendarCredentialMailbox,
  ): Promise<CalendarCredential | null>;
}

@Injectable()
export class UnavailableCalendarCredentials extends CalendarCredentialsPort {
  async resolve(
    _workspaceId: string,
    _mailbox: CalendarCredentialMailbox,
  ): Promise<CalendarCredential | null> {
    return null;
  }
}
