/**
 * Compose attachment wire normalization and policy.
 *
 * The MCP/REST surfaces accept both the current camel-case contract and the
 * older snake-case/blob reference form.  Keeping the policy here makes the
 * limits identical for direct compose, staged approval, and uploaded
 * document references.
 */

export const DEFAULT_ATTACHMENT_MAX_FILES = 5;
export const DEFAULT_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_TYPES = [
  'pdf',
  'png',
  'jpg',
  'txt',
  'csv',
  'md',
  'docx',
  'xlsx',
] as const;

const MIME_TYPES_BY_EXTENSION: Record<string, string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg', 'image/jpg'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv', 'text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

export interface ComposeAttachmentPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowedTypes: Set<string>;
}

/** The accepted attachment spelling at the MCP/REST boundary. */
export interface ComposeAttachmentWireInput {
  documentId?: string;
  document_id?: string;
  blobId?: string;
  blob_id?: string;
  filename?: string;
  name?: string;
  contentType?: string;
  content_type?: string;
  type?: string;
  contentBase64?: string;
  content_base64?: string;
  size?: number;
}

/** One attachment after aliases are normalized, before document lookup. */
export interface NormalizedComposeAttachment {
  documentId?: string;
  blobId?: string;
  filename?: string;
  contentType?: string;
  contentBase64?: string;
  size?: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = raw == null ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Read attachment policy from environment without making a ConfigService a
 * constructor dependency of EmailService. This keeps positional test seams and
 * supports a deployment-specific allow-list without a code change.
 */
export function composeAttachmentPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ComposeAttachmentPolicy {
  const rawTypes = env.EMAIL_OPS_ATTACHMENT_ALLOWED_TYPES;
  const allowedTypes = new Set(
    (rawTypes && rawTypes.trim() ? rawTypes : DEFAULT_ATTACHMENT_TYPES.join(','))
      .split(',')
      .map((value) => value.trim().toLowerCase().split(';', 1)[0])
      .filter(Boolean),
  );
  return {
    maxFiles: positiveInt(env.EMAIL_OPS_ATTACHMENT_MAX_FILES, DEFAULT_ATTACHMENT_MAX_FILES),
    maxFileBytes: positiveInt(
      env.EMAIL_OPS_ATTACHMENT_MAX_FILE_BYTES,
      DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
    ),
    maxTotalBytes: positiveInt(
      env.EMAIL_OPS_ATTACHMENT_MAX_TOTAL_BYTES ?? env.EMAIL_OPS_ATTACHMENT_MAX_BYTES,
      DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
    ),
    allowedTypes,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mimeType(value: string): string {
  return value.trim().toLowerCase().split(';', 1)[0];
}

function extension(filename: string): string {
  const match = /\.([^.]+)$/.exec(filename.trim().toLowerCase());
  return match?.[1] ?? '';
}

function decodedBytes(contentBase64: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new Error('has invalid base64 content.');
  }
  return Buffer.from(contentBase64, 'base64').length;
}

function allowedType(
  filename: string,
  contentType: string,
  policy: ComposeAttachmentPolicy,
): boolean {
  const ext = extension(filename);
  const mime = mimeType(contentType);
  if (!ext || !mime) return false;

  // A configured extension must still carry the MIME type that belongs to it;
  // this prevents a renamed executable from passing only by filename. A custom
  // MIME token remains useful for deployments that add a private file type.
  const extensionConfigured = policy.allowedTypes.has(ext);
  const mimeConfigured = policy.allowedTypes.has(mime);
  if (!extensionConfigured && !mimeConfigured) return false;
  if (!extensionConfigured) return true;
  const expected = MIME_TYPES_BY_EXTENSION[ext];
  return !expected || expected.includes(mime);
}

/** Normalize camel-case, snake-case, and the pre-existing blob reference form. */
export function normalizeComposeAttachment(raw: unknown): NormalizedComposeAttachment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Each attachment must be an object.');
  }
  const value = raw as ComposeAttachmentWireInput;
  const documentId = asNonEmptyString(value.documentId ?? value.document_id);
  const blobId = asNonEmptyString(value.blobId ?? value.blob_id);
  const filename = asNonEmptyString(value.filename ?? value.name);
  const contentType = asNonEmptyString(value.contentType ?? value.content_type ?? value.type);
  const contentBase64 = asNonEmptyString(value.contentBase64 ?? value.content_base64);

  if (documentId && (blobId || contentBase64)) {
    throw new Error('must use documentId or inline content, not both.');
  }
  if (blobId && contentBase64) {
    throw new Error('must use a blob/document reference or inline content, not both.');
  }
  if (!documentId && !blobId && (!filename || !contentType || !contentBase64)) {
    throw new Error('each attachment needs filename, contentType, and contentBase64.');
  }
  if (blobId && (!filename || !contentType)) {
    throw new Error('each blob attachment needs filename and contentType.');
  }
  if (contentBase64) {
    // Validate here so malformed bytes cannot be persisted in a staged message.
    decodedBytes(contentBase64);
  }
  if (value.size != null && (!Number.isInteger(value.size) || value.size < 0)) {
    throw new Error('attachment size must be a non-negative integer.');
  }

  return {
    ...(documentId ? { documentId } : {}),
    ...(blobId ? { blobId } : {}),
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType: mimeType(contentType) } : {}),
    ...(contentBase64 ? { contentBase64 } : {}),
    ...(value.size != null ? { size: value.size } : {}),
  };
}

/** Validate caps/types and return normalized records for service-layer use. */
export function validateComposeAttachments(
  rawAttachments: unknown[] | undefined,
  policy: ComposeAttachmentPolicy = composeAttachmentPolicy(),
): NormalizedComposeAttachment[] {
  if (!rawAttachments?.length) return [];
  if (rawAttachments.length > policy.maxFiles) {
    throw new Error(`At most ${policy.maxFiles} attachments are allowed.`);
  }

  let totalBytes = 0;
  const normalized = rawAttachments.map(normalizeComposeAttachment);
  for (const attachment of normalized) {
    // A documentId is resolved against the tenant/mailbox store by EmailService
    // before this function is called a second time. Its metadata is unknown on
    // the first pass, so only the reference shape is checked there.
    if (attachment.documentId && !attachment.filename && !attachment.contentType) continue;
    if (!attachment.filename || !attachment.contentType) {
      throw new Error('Each attachment needs a filename and contentType.');
    }
    if (!allowedType(attachment.filename, attachment.contentType, policy)) {
      throw new Error(
        `Attachment ${attachment.filename} has a disallowed type (${attachment.contentType}). ` +
          `Allowed types: ${[...policy.allowedTypes].join(', ')}.`,
      );
    }

    const bytes = attachment.contentBase64
      ? decodedBytes(attachment.contentBase64)
      : attachment.size;
    if (bytes != null) {
      if (bytes > policy.maxFileBytes) {
        throw new Error(
          `Attachment ${attachment.filename} exceeds the ${Math.round(policy.maxFileBytes / (1024 * 1024))} MB per-file limit.`,
        );
      }
      totalBytes += bytes;
    }
  }
  if (totalBytes > policy.maxTotalBytes) {
    throw new Error(
      `Attachments exceed the ${Math.round(policy.maxTotalBytes / (1024 * 1024))} MB total limit.`,
    );
  }
  return normalized.map((attachment) =>
    attachment.contentBase64
      ? { ...attachment, size: decodedBytes(attachment.contentBase64) }
      : attachment,
  );
}
