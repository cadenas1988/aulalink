import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EncryptedValue {
  ciphertext: Buffer;
  keyVersion: string;
}

@Injectable()
export class SensitiveDataService {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(config: ConfigService) {
    this.encryptionKey = this.readKey(
      config.getOrThrow<string>('PHONE_ENCRYPTION_KEY'),
      'PHONE_ENCRYPTION_KEY',
    );
    this.lookupKey = this.readKey(
      config.getOrThrow<string>('PHONE_LOOKUP_KEY'),
      'PHONE_LOOKUP_KEY',
    );
  }

  encrypt(plaintext: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, encrypted]),
      keyVersion: 'v1',
    };
  }

  decrypt(ciphertext: Buffer): string {
    if (ciphertext.length < 29) {
      throw new Error('Dato cifrado inválido.');
    }
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf8',
    );
  }

  phoneLookup(phoneE164: string): Buffer {
    return createHmac('sha256', this.lookupKey)
      .update(phoneE164)
      .digest();
  }

  hashDecisionToken(token: string): Buffer {
    return createHmac('sha256', this.lookupKey)
      .update(`pickup-decision:${token}`)
      .digest();
  }

  private readKey(encoded: string, name: string): Buffer {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new Error(`${name} debe ser una clave de 32 bytes codificada en base64.`);
    }
    return key;
  }
}
