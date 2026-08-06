/**
 * The human email-client BFF (read your inboxes + compose), distinct from the
 * agent-inbox approval surface.
 *
 *   GET  workspaces/:workspaceId/mail/threads/aggregate?folder=&limit=&q=&offset=   (unified inbox)
 *   GET  workspaces/:workspaceId/mail/counts                                        (per-mailbox inbox counts)
 *   POST workspaces/:workspaceId/mail/threads/bulk                                  (BulkThreadsDto)
 *   GET  workspaces/:workspaceId/mail/:mailboxId/threads?folder=&limit=&q=&offset=
 *   GET  workspaces/:workspaceId/mail/:mailboxId/threads/:threadId
 *   PUT  workspaces/:workspaceId/mail/:mailboxId/threads/:threadId/read             (SetReadDto)
 *   GET  workspaces/:workspaceId/mail/:mailboxId/blobs/:blobId?name=&type=          (attachment download)
 *   POST workspaces/:workspaceId/mail/:mailboxId/attachments                        (multipart `file`, 25MB)
 *   POST workspaces/:workspaceId/mail/:mailboxId/compose                            (ComposeMailDto)
 *
 * JWT + membership guarded (every route — including the blob download, which an
 * XHR reaches with the same plain Bearer token as the rest). Delegates to
 * EmailService (the SoR + the mail-engine seam) — so it's degrade-clean: reads
 * return the SoR view while the engine is dormant and light up with received
 * mail when it's live; a compose is recorded and queued to the engine
 * (FAILED-clean if dormant). Sends as the chosen mailbox.
 *
 * Webmail-wave error semantics (binding for the FE): a capability the engine
 * can't serve is 404 (blob unknown/unreachable) or 501 (upload unsupported) —
 * NEVER a 500. Paging: `offset` is a plain row offset; a full page (length ==
 * limit) means "may have more".
 */

import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  NotImplementedException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Response } from 'express';
import { MessageDisposition, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { BulkThreadAction, ComposeInput, MailFolder } from '../email/email.types';

const MAIL_FOLDERS: MailFolder[] = ['inbox', 'archive', 'spam', 'trash', 'sent', 'drafts'];
function normalizeFolder(raw?: string): MailFolder {
  const f = (raw ?? '').toLowerCase() as MailFolder;
  return MAIL_FOLDERS.includes(f) ? f : 'inbox';
}

function parseLimit(raw?: string): number {
  return raw ? Math.min(Number.parseInt(raw, 10) || 50, 200) : 50;
}

function parseOffset(raw?: string): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Light address shape check for the comma-split to/cc/bcc entries. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BULK_ACTIONS: BulkThreadAction[] = ['archive', 'trash', 'spam', 'inbox', 'read', 'unread'];
const BULK_DISPOSITION: Partial<Record<BulkThreadAction, MessageDisposition>> = {
  archive: MessageDisposition.ARCHIVE,
  trash: MessageDisposition.TRASH,
  spam: MessageDisposition.SPAM,
  inbox: MessageDisposition.INBOX,
};

function normalizeComposeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
}

class ComposeMailDto {
  /** One address, or several comma-joined (the FE sends multi-recipient this way). */
  @IsString() @MaxLength(2000) to_address!: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @IsOptional() @IsString() @MaxLength(50000) body?: string;
  @IsOptional() @IsString() @MaxLength(100000) body_html?: string;
  @IsOptional() @IsString() in_reply_to_thread_id?: string;
  @IsOptional() @IsString() @MaxLength(500) draft_id?: string;
  // webmail wave — all optional (back-compat).
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsEmail({}, { each: true }) cc?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsEmail({}, { each: true }) bcc?: string[];
  /** Uploaded attachment refs: [{blob_id, name, type}] (validated shape-wise below). */
  @IsOptional() @IsArray() @ArrayMaxSize(20) attachments?: { blob_id: string; name: string; type: string }[];
  /** The INTERNAL message id being replied to (from the thread detail) — the server resolves the real Message-ID/References. */
  @IsOptional() @IsString() @MaxLength(500) in_reply_to?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) references?: string[];
}

class SetReadDto {
  @IsBoolean() read!: boolean;
}

class SetFlagsDto {
  @IsOptional() @IsBoolean() flagged?: boolean;
  @IsOptional() @IsBoolean() seen?: boolean;
}

class EmptyFolderDto {
  @IsBoolean() confirm!: boolean;
}

class CreateFolderDto {
  @IsString() @MaxLength(200) name!: string;
  /** Optional parent folder id, to nest the new folder. */
  @IsOptional() @IsString() @MaxLength(500) parent_id?: string;
}

class RenameFolderDto {
  @IsString() @MaxLength(200) name!: string;
}

class MoveThreadDto {
  /** The target CUSTOM folder's JMAP mailbox id (from GET .../folders). */
  @IsString() @MaxLength(500) folder_id!: string;
}

class BulkThreadsDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) thread_ids!: string[];
  @IsIn(BULK_ACTIONS) action!: BulkThreadAction;
}

function parseComposePayload(body: ComposeMailDto) {
  const toAddresses = body.to_address
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (!toAddresses.length || toAddresses.some((a) => !ADDRESS_RE.test(a))) {
    throw new BadRequestException('to_address must be one or more comma-separated email addresses.');
  }
  const attachments = (body.attachments ?? []).map((a) => {
    if (!a || typeof a.blob_id !== 'string' || !a.blob_id.trim()) {
      throw new BadRequestException('each attachment needs a blob_id (from POST .../attachments).');
    }
    return {
      blob_id: a.blob_id,
      name: typeof a.name === 'string' && a.name.trim() ? a.name : 'attachment',
      type: typeof a.type === 'string' && a.type.trim() ? a.type : 'application/octet-stream',
    };
  });
  return { toAddresses, attachments };
}

@ApiTags('mail')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mail')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailController {
  constructor(private readonly email: EmailService) {}

  // Static routes FIRST so ':mailboxId' can never shadow them.

  @Get('threads/aggregate')
  @ApiOperation({ summary: 'The unified inbox: every workspace mailbox merged, newest-first.' })
  @ApiResponse({ status: 200, description: 'The merged threads (each carries mailbox_id + mailbox_address) + count + folder.' })
  async aggregate(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query('limit') limitRaw?: string,
    @Query('folder') folderRaw?: string,
    @Query('q') q?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const folder = normalizeFolder(folderRaw);
    const threads = await this.email.listAggregateInbox(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      folder,
      limit,
      q ?? null,
      parseOffset(offsetRaw),
    );
    return { threads, count: threads.length, folder };
  }

  @Get('counts')
  @ApiOperation({ summary: 'Inbox unread/total per workspace mailbox (a failing account = zeros + error:true).' })
  @ApiResponse({ status: 200, description: 'The per-mailbox counts.' })
  async counts(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const mailboxes = await this.email.getWorkspaceMailCounts(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
    );
    return { mailboxes };
  }

  @Post('threads/bulk')
  @ApiOperation({ summary: 'Bulk thread actions: archive/trash/spam/inbox (disposition) or read/unread ($seen).' })
  @ApiResponse({ status: 201, description: '{ succeeded: string[], failed: string[] } (thread ids).' })
  async bulk(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: BulkThreadsDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const succeeded: string[] = [];
    const failed: string[] = [];
    const target = BULK_DISPOSITION[body.action];
    // Per-thread isolation: one failing thread never fails the batch.
    const settled = await Promise.allSettled(
      body.thread_ids.map(async (threadId) => {
        if (target) {
          // archive/trash/spam/inbox — the EXACT same disposition logic as the
          // single-thread PUT .../disposition route: reconcile the real James
          // mailbox AND tag the overlay, so bulk triage doesn't undo itself.
          await this.email.applyThreadDisposition(workspaceId, ucUid, threadId, target);
          return true;
        }
        // read/unread — the same $seen keyword logic as PUT .../threads/:id/read,
        // resolved across the workspace's mailboxes (the bulk route has no mailbox
        // in its path while JMAP thread ids live per-account).
        return this.email.setThreadReadAcrossMailboxes(
          workspaceId,
          ucUid,
          threadId,
          body.action === 'read',
        );
      }),
    );
    settled.forEach((r, i) => {
      const id = body.thread_ids[i];
      if (r.status === 'fulfilled' && r.value) succeeded.push(id);
      else failed.push(id);
    });
    return { succeeded, failed };
  }

  @Get(':mailboxId/threads')
  @ApiOperation({ summary: "A mailbox's recent threads for a folder (the client inbox list); q = full-text search, offset = paging." })
  @ApiResponse({ status: 200, description: 'The threads + count + folder.' })
  async threads(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Query('limit') limitRaw?: string,
    @Query('folder') folderRaw?: string,
    @Query('q') q?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const folder = normalizeFolder(folderRaw);
    const threads = await this.email.listMailboxInbox(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      limit,
      folder,
      q ?? null,
      parseOffset(offsetRaw),
    );
    return { threads, count: threads.length, folder };
  }

  @Get(':mailboxId/threads/:threadId')
  @ApiOperation({ summary: 'The messages in a thread (full bodies + attachments when the engine serves them).' })
  @ApiResponse({ status: 200, description: 'The messages + count.' })
  async thread(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
  ) {
    const messages = await this.email.listThreadMessages(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      threadId,
      mailboxId,
    );
    return { messages, count: messages.length };
  }

  @Put(':mailboxId/threads/:threadId/read')
  @ApiOperation({ summary: 'Set/clear the $seen keyword on every message in the thread.' })
  @ApiResponse({ status: 200, description: '{ thread_id, read, updated } — updated:false = the engine could not apply it.' })
  async setRead(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
    @Body() body: SetReadDto,
  ) {
    return this.email.setThreadReadState(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      threadId,
      body.read,
    );
  }

  @Put(':mailboxId/threads/:threadId/move')
  @ApiOperation({ summary: 'Move a thread INTO a custom folder (by folder_id from GET .../folders).' })
  @ApiResponse({ status: 200, description: '{ moved } — moved:false = unknown target/thread, external mailbox, or dormant engine.' })
  async moveThread(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
    @Body() body: MoveThreadDto,
  ) {
    const folderId = body.folder_id.trim();
    if (!folderId) throw new BadRequestException('folder_id is required.');
    return this.email.moveThreadToCustomFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      threadId,
      folderId,
    );
  }

  @Patch(':mailboxId/threads/:threadId/flags')
  @ApiOperation({ summary: 'Set/clear IMAP keywords on a thread: \\Flagged and/or \\Seen.' })
  @ApiResponse({ status: 200, description: '{ thread_id, flagged?, seen?, updated }.' })
  async setFlags(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
    @Body() body: SetFlagsDto,
  ) {
    if (body.flagged === undefined && body.seen === undefined) {
      throw new BadRequestException('Provide flagged and/or seen.');
    }
    return this.email.setThreadFlagState(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      threadId,
      { flagged: body.flagged, seen: body.seen },
    );
  }

  @Post(':mailboxId/folders/:folder/empty')
  @ApiOperation({ summary: 'Permanently empty Trash or Spam/Junk after explicit confirmation.' })
  @ApiResponse({ status: 201, description: '{ folder, purged, updated }.' })
  async emptyFolder(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('folder') folder: string,
    @Body() body: EmptyFolderDto,
  ) {
    if (folder !== 'trash' && folder !== 'spam') {
      throw new BadRequestException('Only trash and spam can be emptied.');
    }
    if (!body.confirm) throw new BadRequestException('Confirmation is required.');
    return this.email.emptyMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      folder,
    );
  }

  @Get(':mailboxId/folders')
  @ApiOperation({ summary: 'List every folder (system role + custom) under the mailbox — the folder rail / move-to menu.' })
  @ApiResponse({ status: 200, description: '{ folders: [{ id, name, role, parentId, unread? }] }. [] when the engine is dormant or external.' })
  async listFolders(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
  ) {
    const folders = await this.email.listMailboxFolders(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
    );
    return { folders, count: folders.length };
  }

  @Post(':mailboxId/folders')
  @ApiOperation({ summary: 'Create a custom folder (optionally nested under parent_id).' })
  @ApiResponse({ status: 201, description: '{ id } of the new folder.' })
  @ApiResponse({ status: 501, description: 'The mail engine cannot create folders (dormant or external mailbox).' })
  async createFolder(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: CreateFolderDto,
  ) {
    const name = body.name.trim();
    if (!name) throw new BadRequestException('Folder name is required.');
    const created = await this.email.createMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      name,
      body.parent_id?.trim() || null,
    );
    if (!created) {
      throw new NotImplementedException(
        'The mail engine cannot create folders right now (dormant or external mailbox).',
      );
    }
    return created;
  }

  @Get(':mailboxId/folders/:folderId/threads')
  @ApiOperation({ summary: "A custom folder's threads (live JMAP; q = full-text search, offset = paging)." })
  @ApiResponse({ status: 200, description: 'The threads + count. [] when the engine is dormant or the mailbox is external.' })
  async customFolderThreads(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('folderId') folderId: string,
    @Query('limit') limitRaw?: string,
    @Query('q') q?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const threads = await this.email.listCustomFolderThreads(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      folderId,
      parseLimit(limitRaw),
      q ?? null,
      parseOffset(offsetRaw),
    );
    return { threads, count: threads.length };
  }

  @Patch(':mailboxId/folders/:folderId')
  @ApiOperation({ summary: 'Rename a custom folder.' })
  @ApiResponse({ status: 200, description: '{ updated } — updated:false = the engine could not apply it.' })
  async renameFolder(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('folderId') folderId: string,
    @Body() body: RenameFolderDto,
  ) {
    const name = body.name.trim();
    if (!name) throw new BadRequestException('Folder name is required.');
    return this.email.renameMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      folderId,
      name,
    );
  }

  @Delete(':mailboxId/folders/:folderId')
  @ApiOperation({ summary: 'Delete a CUSTOM folder. System/role folders (Inbox/Sent/Archive/Trash/Junk/Drafts) are never deletable.' })
  @ApiResponse({ status: 200, description: '{ deleted } — deleted:false = a role folder was refused, or it is unknown/external/dormant.' })
  async deleteFolder(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('folderId') folderId: string,
  ) {
    return this.email.deleteMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      folderId,
    );
  }

  @Get(':mailboxId/blobs/:blobId')
  @ApiOperation({ summary: 'Download one attachment blob (server-side engine auth; plain Bearer for the client).' })
  @ApiResponse({ status: 200, description: 'The blob bytes (Content-Type/-Disposition from the query params).' })
  @ApiResponse({ status: 404, description: 'Unknown blob, unreachable mailbox, or the engine cannot serve blobs.' })
  async downloadBlob(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('blobId') blobId: string,
    @Res() res: Response,
    @Query('name') name?: string,
    @Query('type') type?: string,
  ) {
    const blob = await this.email.downloadAttachment(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      blobId,
    );
    if (!blob) throw new NotFoundException('Attachment blob not found (or the mail engine cannot serve it).');
    const contentType = (type && type.trim()) || blob.contentType || 'application/octet-stream';
    // RFC 5987 filename* so any unicode name survives; a plain fallback too.
    const safeName = (name && name.trim()) || 'attachment';
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Content-Length': String(blob.data.length),
    });
    res.send(blob.data);
  }

  @Post(':mailboxId/attachments')
  @ApiOperation({ summary: 'Upload a compose attachment (multipart `file`, 25MB cap) to the mail engine blob store.' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: '{ blob_id, name, type, size } — reference it from compose.attachments.' })
  @ApiResponse({ status: 501, description: 'The mail engine cannot accept uploads (dormant or non-JMAP).' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async uploadAttachment(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    if (!file?.buffer) throw new BadRequestException('Multipart field `file` is required.');
    const result = await this.email.uploadAttachment(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      file.buffer,
      file.mimetype || 'application/octet-stream',
      file.originalname || 'attachment',
    );
    if (!result) {
      throw new NotImplementedException(
        'The mail engine cannot accept attachment uploads right now (dormant or non-JMAP engine).',
      );
    }
    return result;
  }

  @Post(':mailboxId/drafts')
  @ApiOperation({ summary: 'Create a persistent draft in the mailbox Drafts folder.' })
  async createDraft(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: ComposeMailDto,
  ) {
    const { toAddresses, attachments } = parseComposePayload(body);
    return this.email.saveOrUpdateDraft(workspaceId, ucUidOf(user as WithWorkspaceClaim), mailboxId, null, {
      toAddress: toAddresses[0],
      toAddresses: toAddresses.length > 1 ? toAddresses : undefined,
      subject: body.subject ?? '',
      body: body.body ?? '',
      bodyHtml: body.body_html ? normalizeComposeHtml(body.body_html) : null,
      cc: body.cc?.length ? body.cc : undefined,
      bcc: body.bcc?.length ? body.bcc : undefined,
      attachments: attachments.length
        ? attachments.map((a) => ({ blobId: a.blob_id, name: a.name, type: a.type }))
        : undefined,
      inReplyToMessageId: body.in_reply_to ?? null,
    });
  }

  @Put(':mailboxId/drafts/:draftId')
  @ApiOperation({ summary: 'Update a persistent draft in the mailbox Drafts folder.' })
  async updateDraft(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('draftId') draftId: string,
    @Body() body: ComposeMailDto,
  ) {
    const { toAddresses, attachments } = parseComposePayload(body);
    return this.email.saveOrUpdateDraft(workspaceId, ucUidOf(user as WithWorkspaceClaim), mailboxId, draftId, {
      toAddress: toAddresses[0],
      toAddresses: toAddresses.length > 1 ? toAddresses : undefined,
      subject: body.subject ?? '',
      body: body.body ?? '',
      bodyHtml: body.body_html ? normalizeComposeHtml(body.body_html) : null,
      cc: body.cc?.length ? body.cc : undefined,
      bcc: body.bcc?.length ? body.bcc : undefined,
      attachments: attachments.length
        ? attachments.map((a) => ({ blobId: a.blob_id, name: a.name, type: a.type }))
        : undefined,
      inReplyToMessageId: body.in_reply_to ?? null,
    });
  }

  @Delete(':mailboxId/drafts/:draftId')
  @ApiOperation({ summary: 'Delete a persistent draft from the mailbox Drafts folder.' })
  async deleteDraft(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('draftId') draftId: string,
  ) {
    return this.email.deleteDraft(workspaceId, ucUidOf(user as WithWorkspaceClaim), mailboxId, draftId);
  }

  @Post(':mailboxId/compose')
  @ApiOperation({ summary: 'Send an email AS the given mailbox (reply when in_reply_to_thread_id; threading headers resolved from in_reply_to).' })
  @ApiResponse({ status: 201, description: 'The composed message (queued/sent/failed-clean).' })
  async compose(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: ComposeMailDto,
  ) {
    const { toAddresses, attachments } = parseComposePayload(body);
    const input: ComposeInput = {
      contactId: null,
      toAddress: toAddresses[0],
      toAddresses: toAddresses.length > 1 ? toAddresses : undefined,
      subject: body.subject ?? '',
      body: body.body ?? '',
      bodyHtml: body.body_html ? normalizeComposeHtml(body.body_html) : null,
      mode: 'send',
      inReplyToThreadId: body.in_reply_to_thread_id ?? null,
      externalSource: 'email-ops-client',
      externalRef: randomUUID(),
      draftedBy: null,
      fromMailboxAccountId: mailboxId,
      draftId: body.draft_id ?? null,
      cc: body.cc?.length ? body.cc : undefined,
      bcc: body.bcc?.length ? body.bcc : undefined,
      attachments: attachments.length ? attachments : undefined,
      inReplyToMessageId: body.in_reply_to ?? null,
      references: body.references?.length ? body.references : undefined,
    };
    return this.email.composeEmail(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }
}
