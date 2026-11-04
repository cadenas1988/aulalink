import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PhotoStorageService implements OnApplicationShutdown {
  private readonly logger = new Logger(PhotoStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly urlTtlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.urlTtlSeconds = Number(
      config.get<string>('PHOTO_URL_TTL_SECONDS') ?? 300,
    );
    if (
      !Number.isInteger(this.urlTtlSeconds) ||
      this.urlTtlSeconds < 30 ||
      this.urlTtlSeconds > 900
    ) {
      throw new Error('PHOTO_URL_TTL_SECONDS debe estar entre 30 y 900.');
    }
    this.client = new S3Client({
      region: config.get<string>('S3_REGION') ?? 'us-east-1',
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      credentials:
        config.get<string>('S3_ACCESS_KEY_ID') &&
        config.get<string>('S3_SECRET_ACCESS_KEY')
          ? {
              accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
              secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
            }
          : undefined,
    });
  }

  async store(bytes: Buffer, contentType: string): Promise<string> {
    const key = `pickup-photos/${randomUUID()}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
          Metadata: { purpose: 'pickup-authorization' },
        }),
      );
      return key;
    } catch (error) {
      this.logger.error(
        'Falló la carga privada de una fotografía.',
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'No fue posible guardar la fotografía de forma privada.',
      );
    }
  }

  async temporaryUrl(key: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: this.urlTtlSeconds },
      );
    } catch (error) {
      this.logger.error(
        'Falló la generación de una URL temporal para fotografía.',
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'No fue posible generar el acceso temporal a la fotografía.',
      );
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.destroy();
  }
}
