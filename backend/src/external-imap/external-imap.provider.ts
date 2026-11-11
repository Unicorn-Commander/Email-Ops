import { Injectable } from '@nestjs/common';
import { MailboxAccount } from '@prisma/client';
import {
  FetchMessageObject,
  ImapFlow,
  MessageAddressObject,
  MessageStructureObject,
} from 'imapflow';
import {
  MailProviderPort,
  MailProviderListOpts,
  MailProviderListResult,
  MailProviderThreadResult,
  MailReadStatus,
} from '../mail-provider/mail-provider.port';
import { MessageView, ParticipantView, ThreadView } from '../email/email.types';
import { ExternalImapAccounts } from './external-imap.accounts';
import { connectionStatus, externalImapEnabled, ImapConnection } from './imap-connection';
import { bodyParts, groupMessages, references } from './imap-messages';

export const IMAP_SEND_UNAVAILABLE = 'Sending from this mailbox is not available yet.';
const MAX_PART_BYTES = 25 * 1024 * 1024;
const participants = (addresses?: MessageAddressObject[]): ParticipantView[] =>
  (addresses ?? [])
    .filter((p) => !!p.address)
    .map((p) => ({ address: p.address!, name: p.name ?? null }));
const date = (message: FetchMessageObject) => {
  const value = message.envelope?.date ?? message.internalDate;
  return value ? new Date(value).toISOString() : null;
};

@Injectable()
export class ExternalImapProvider extends MailProviderPort {
  constructor(
    private readonly accounts: ExternalImapAccounts,
    private readonly connection: ImapConnection,
  ) {
    super();
  }

  // Always claim this type, including flag-off, so it can NEVER fall into James.
  handles(mailbox: Pick<MailboxAccount, 'provider'>) {
    return mailbox.provider === 'external_imap';
  }

  private async run<T>(mailbox: MailboxAccount, operation: (client: ImapFlow) => Promise<T>) {
    return this.connection.run(
      mailbox.workspaceId,
      await this.accounts.credentials(mailbox),
      operation,
    );
  }

  private status(workspaceId: string, error: unknown): MailReadStatus {
    if (!externalImapEnabled(workspaceId)) return 'engine_not_configured';
    const status = connectionStatus(error);
    return status === 'auth_failed'
      ? 'provider_auth_failed'
      : status === 'tls_failed'
        ? 'provider_error'
        : 'engine_unreachable';
  }

  private async index(client: ImapFlow) {
    if (!client.mailbox) throw new Error('INBOX unavailable');
    // Bound memory/work without presenting a partial mailbox as a complete one.
    if (client.mailbox.exists > 10000) throw new Error('INBOX exceeds phase one limit');
    const validity = String(client.mailbox.uidValidity);
    const messages = client.mailbox.exists
      ? await client.fetchAll('1:*', {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true,
          headers: ['References', 'In-Reply-To', 'Message-ID'],
        })
      : [];
    return { validity, messages, groups: groupMessages(messages, validity) };
  }

  async listInbox(
    mailbox: MailboxAccount,
    opts: MailProviderListOpts,
  ): Promise<MailProviderListResult> {
    const empty: MailProviderListResult = {
      threads: [],
      nextPageToken: null,
      hasMore: false,
      searchSupported: false,
      reason: null,
      status: 'ok',
    };
    if (!externalImapEnabled(mailbox.workspaceId))
      return { ...empty, status: 'engine_not_configured' };
    if (opts.folder !== 'inbox' || opts.query?.trim())
      return { ...empty, reason: 'Only INBOX browsing is available for IMAP in phase 1.' };
    try {
      return await this.run(mailbox, async (client) => {
        const { groups, validity } = await this.index(client);
        let offset = opts.offset ?? 0;
        if (opts.pageToken) {
          const match = /^(\d+):(\d+)$/.exec(opts.pageToken);
          if (!match || match[1] !== validity) throw new Error('Invalid page token');
          offset = Number(match[2]);
        }
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
        const threads: ThreadView[] = [...groups]
          .map(([id, messages]) => {
            messages.sort((a, b) => (date(a) ?? '').localeCompare(date(b) ?? '') || a.uid - b.uid);
            const last = messages[messages.length - 1];
            return {
              id,
              subject: messages[0].envelope?.subject ?? null,
              message_count: messages.length,
              unread: messages.some((m) => !m.flags?.has('\\Seen')),
              flagged: false,
              last_message_at: date(last),
              last_snippet: null,
              participants: [
                ...new Map(
                  messages
                    .flatMap((m) =>
                      participants([...(m.envelope?.from ?? []), ...(m.envelope?.to ?? [])]),
                    )
                    .map((p) => [p.address, p]),
                ).values(),
              ],
              has_attachments: messages.some(
                (m) => bodyParts(m.bodyStructure).attachments.length > 0,
              ),
            };
          })
          .sort(
            (a, b) =>
              (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '') ||
              a.id.localeCompare(b.id),
          );
        const limit = Math.min(100, Math.max(1, opts.limit || 50));
        const next = offset + limit < threads.length ? `${validity}:${offset + limit}` : null;
        return {
          ...empty,
          threads: threads.slice(offset, offset + limit),
          nextPageToken: next,
          hasMore: !!next,
        };
      });
    } catch (error) {
      return {
        ...empty,
        status: this.status(mailbox.workspaceId, error),
        reason: 'IMAP inbox is unavailable.',
      };
    }
  }

  private async bytes(
    client: ImapFlow,
    uid: number,
    part: MessageStructureObject,
    decodeText: boolean,
  ) {
    if ((part.size ?? 0) > MAX_PART_BYTES) throw new Error('Part exceeds size limit');
    const download = await client.download(String(uid), part.part, {
      uid: true,
      maxBytes: MAX_PART_BYTES + 1,
      decodeText,
    });
    if (!download.content) throw new Error('Part unavailable');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of download.content) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_PART_BYTES) {
        download.content.destroy();
        throw new Error('Part exceeds size limit');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async listThreadMessages(
    mailbox: MailboxAccount,
    threadId: string,
  ): Promise<MailProviderThreadResult> {
    try {
      return await this.run(mailbox, async (client) => {
        const { groups, validity } = await this.index(client);
        const messages: MessageView[] = [];
        for (const message of (groups.get(threadId) ?? []).sort((a, b) => a.uid - b.uid)) {
          const id = `imap-${validity}-${message.uid}`;
          const parts = bodyParts(message.bodyStructure);
          let text = '',
            html = '';
          for (const part of parts.body) {
            const body = (await this.bytes(client, message.uid, part, true)).toString('utf8');
            if (part.type === 'text/html') html += body;
            else text += body;
          }
          messages.push({
            id,
            thread_id: threadId,
            from: participants(message.envelope?.from)[0] ?? null,
            to: participants(message.envelope?.to),
            cc: participants(message.envelope?.cc),
            subject: message.envelope?.subject ?? null,
            sent_at: date(message),
            direction: 'received',
            preview: text.slice(0, 200) || null,
            text_body: text || null,
            html_body: html || null,
            message_id_header: message.envelope?.messageId ?? null,
            references: references(message),
            is_unread: !message.flags?.has('\\Seen'),
            attachments: parts.attachments.map((p) => ({
              blob_id: `${id}::${p.part}`,
              name: p.dispositionParameters?.filename ?? p.parameters?.name ?? null,
              type: p.type,
              size: p.size ?? null,
              cid: p.id?.replace(/^<|>$/g, '') ?? null,
            })),
          });
        }
        return { messages, status: 'ok' };
      });
    } catch (error) {
      return { messages: [], status: this.status(mailbox.workspaceId, error) };
    }
  }

  async setThreadRead(mailbox: MailboxAccount, threadId: string, read: boolean) {
    try {
      return await this.run(mailbox, async (client) => {
        const { groups } = await this.index(client);
        const messages = groups.get(threadId);
        if (!messages?.length) return false;
        const uids = messages.map((m) => m.uid);
        return read
          ? client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
          : client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      });
    } catch {
      return false;
    }
  }

  async getInboxCounts(mailbox: MailboxAccount) {
    try {
      return await this.run(mailbox, async (client) => {
        const result = await client.status('INBOX', { messages: true, unseen: true });
        if (!result) return null;
        return { inboxTotal: result.messages ?? 0, inboxUnread: result.unseen ?? 0 };
      });
    } catch {
      return null;
    }
  }

  async downloadAttachment(mailbox: MailboxAccount, messageId: string, attachmentId: string) {
    if (!/^imap-\d+-\d+$/.test(messageId) || !/^\d+(?:\.\d+)*$/.test(attachmentId)) return null;
    try {
      return await this.run(mailbox, async (client) => {
        const [, validity, uid] = messageId.split('-');
        if (!client.mailbox || String(client.mailbox.uidValidity) !== validity) return null;
        const message = await client.fetchOne(
          uid,
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        if (!message) return null;
        const part = bodyParts(message.bodyStructure).attachments.find(
          (p) => p.part === attachmentId,
        );
        if (!part) return null;
        return {
          data: await this.bytes(client, Number(uid), part, false),
          contentType: part.type,
          filename: part.dispositionParameters?.filename ?? part.parameters?.name ?? null,
        };
      });
    } catch {
      return null;
    }
  }

  async send() {
    return {
      accepted: false,
      providerMessageId: null,
      threadId: null,
      reason: IMAP_SEND_UNAVAILABLE,
    };
  }
  async createDraft() {
    return {
      created: false,
      draftId: null,
      threadId: null,
      webLink: null,
      reason: IMAP_SEND_UNAVAILABLE,
    };
  }
  async deleteDraft() {
    return false;
  }
  async archiveThread() {
    return false;
  }
  async trashThread() {
    return false;
  }
  async spamThread() {
    return false;
  }
  async restoreThreadToInbox() {
    return false;
  }
  async setThreadFlagged() {
    return false;
  }
  async pollInbound() {
    return null;
  }
  async resolveOwnAddress() {
    return null;
  }
}
