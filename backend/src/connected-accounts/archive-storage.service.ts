import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ArchiveStorageService {
  private readonly logger = new Logger(ArchiveStorageService.name);
  private readonly client: S3Client | null;

  constructor(private readonly config: ConfigService) {
    this.client = this.buildClient();
  }

  get bucket(): string {
    return this.config.get<string>('GARAGE_ARCHIVE_BUCKET')?.trim() || 'email-ops-archives';
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async presignGet(bucket: string, key: string, expiresInSeconds = 900): Promise<string> {
    if (!this.client) throw new Error('Garage/S3 archive storage is not configured');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    if (!this.client) throw new Error('Garage/S3 archive storage is not configured');
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  private buildClient(): S3Client | null {
    const endpoint = this.config.get<string>('GARAGE_S3_ENDPOINT')?.trim();
    const accessKeyId = this.config.get<string>('GARAGE_S3_ACCESS_KEY')?.trim();
    const secretAccessKey = this.config.get<string>('GARAGE_S3_SECRET_KEY')?.trim();
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      this.logger.warn('Garage/S3 archive storage is not configured; archive download/expiry are unavailable.');
      return null;
    }

    return new S3Client({
      endpoint,
      region: this.config.get<string>('GARAGE_S3_REGION')?.trim() || 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
}
