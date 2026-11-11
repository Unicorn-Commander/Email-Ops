import { Injectable } from '@nestjs/common';
import { MailboxAccount } from '@prisma/client';
import { ExternalImapProvider } from '../external-imap/external-imap.provider';
import { EngineMailProvider } from './engine-mail-provider';
import { MailProviderPort } from './mail-provider.port';

/** Keep all external dispatch, including disabled IMAP send refusal, on this seam. */
@Injectable()
export class RoutingMailProvider extends MailProviderPort {
  constructor(
    private readonly engine: EngineMailProvider,
    private readonly imap: ExternalImapProvider,
  ) {
    super();
  }
  handles(mailbox: Pick<MailboxAccount, 'provider'>) {
    return this.imap.handles(mailbox) || this.engine.handles(mailbox);
  }
  private forMailbox(mailbox: MailboxAccount): MailProviderPort {
    return this.imap.handles(mailbox) ? this.imap : this.engine;
  }
  listInbox(...args: Parameters<MailProviderPort['listInbox']>) {
    return this.forMailbox(args[0]).listInbox(...args);
  }
  listThreadMessages(...args: Parameters<MailProviderPort['listThreadMessages']>) {
    return this.forMailbox(args[0]).listThreadMessages(...args);
  }
  send(...args: Parameters<MailProviderPort['send']>) {
    return this.forMailbox(args[0]).send(...args);
  }
  createDraft(...args: Parameters<MailProviderPort['createDraft']>) {
    return this.forMailbox(args[0]).createDraft(...args);
  }
  deleteDraft(...args: Parameters<MailProviderPort['deleteDraft']>) {
    return this.forMailbox(args[0]).deleteDraft(...args);
  }
  archiveThread(...args: Parameters<MailProviderPort['archiveThread']>) {
    return this.forMailbox(args[0]).archiveThread(...args);
  }
  trashThread(...args: Parameters<MailProviderPort['trashThread']>) {
    return this.forMailbox(args[0]).trashThread(...args);
  }
  spamThread(...args: Parameters<MailProviderPort['spamThread']>) {
    return this.forMailbox(args[0]).spamThread(...args);
  }
  restoreThreadToInbox(...args: Parameters<MailProviderPort['restoreThreadToInbox']>) {
    return this.forMailbox(args[0]).restoreThreadToInbox(...args);
  }
  setThreadRead(...args: Parameters<MailProviderPort['setThreadRead']>) {
    return this.forMailbox(args[0]).setThreadRead(...args);
  }
  setThreadFlagged(...args: Parameters<MailProviderPort['setThreadFlagged']>) {
    return this.forMailbox(args[0]).setThreadFlagged(...args);
  }
  getInboxCounts(...args: Parameters<MailProviderPort['getInboxCounts']>) {
    return this.forMailbox(args[0]).getInboxCounts(...args);
  }
  downloadAttachment(...args: Parameters<MailProviderPort['downloadAttachment']>) {
    return this.forMailbox(args[0]).downloadAttachment(...args);
  }
  pollInbound(...args: Parameters<MailProviderPort['pollInbound']>) {
    return this.forMailbox(args[0]).pollInbound(...args);
  }
  resolveOwnAddress(...args: Parameters<MailProviderPort['resolveOwnAddress']>) {
    return this.engine.resolveOwnAddress(...args);
  }
}
