import {
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
  composeAttachmentPolicy,
  normalizeComposeAttachment,
  validateComposeAttachments,
} from './compose-attachments';

describe('compose attachment policy', () => {
  it('normalizes the camel-case inline contract and records decoded size', () => {
    expect(
      validateComposeAttachments([
        {
          filename: 'brief.PDF',
          contentType: 'application/pdf; charset=binary',
          contentBase64: 'SGVsbG8=',
        },
      ]),
    ).toEqual([
      {
        filename: 'brief.PDF',
        contentType: 'application/pdf',
        contentBase64: 'SGVsbG8=',
        size: 5,
      },
    ]);
  });

  it('accepts a document reference without trusting caller-supplied metadata', () => {
    expect(normalizeComposeAttachment({ documentId: 'doc-123' })).toEqual({
      documentId: 'doc-123',
    });
  });

  it('rejects a file over the default 10 MiB per-file cap', () => {
    expect(() =>
      validateComposeAttachments([
        {
          blob_id: 'doc-too-large',
          filename: 'large.pdf',
          content_type: 'application/pdf',
          size: DEFAULT_ATTACHMENT_MAX_FILE_BYTES + 1,
        },
      ]),
    ).toThrow(/per-file limit/);
  });

  it('rejects a set over the default 20 MiB total cap', () => {
    const each = Math.floor(DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES / 3) + 1;
    expect(() =>
      validateComposeAttachments(
        [1, 2, 3].map((n) => ({
          blob_id: `doc-${n}`,
          filename: `part-${n}.pdf`,
          content_type: 'application/pdf',
          size: each,
        })),
      ),
    ).toThrow(/total limit/);
  });

  it('rejects a type outside the configured allow-list', () => {
    expect(() =>
      validateComposeAttachments([
        {
          filename: 'payload.zip',
          contentType: 'application/zip',
          contentBase64: 'UEs=',
        },
      ]),
    ).toThrow(/disallowed type/);
  });

  it('uses deployment policy overrides for file count, bytes, and custom types', () => {
    const policy = composeAttachmentPolicy({
      EMAIL_OPS_ATTACHMENT_MAX_FILES: '1',
      EMAIL_OPS_ATTACHMENT_MAX_FILE_BYTES: '4',
      EMAIL_OPS_ATTACHMENT_MAX_TOTAL_BYTES: '4',
      EMAIL_OPS_ATTACHMENT_ALLOWED_TYPES: 'application/x-report',
    });
    expect(
      validateComposeAttachments(
        [
          {
            filename: 'report.custom',
            contentType: 'application/x-report',
            contentBase64: 'YWJj',
          },
        ],
        policy,
      )[0].size,
    ).toBe(3);
    expect(() =>
      validateComposeAttachments(
        [
          {
            filename: 'report.custom',
            contentType: 'application/x-report',
            contentBase64: 'YWJjZGU=',
          },
        ],
        policy,
      ),
    ).toThrow(/per-file limit/);
  });

  it('rejects malformed base64 before a staged row can be written', () => {
    expect(() =>
      validateComposeAttachments([
        {
          filename: 'notes.txt',
          contentType: 'text/plain',
          contentBase64: 'not base64',
        },
      ]),
    ).toThrow(/invalid base64/);
  });
});
