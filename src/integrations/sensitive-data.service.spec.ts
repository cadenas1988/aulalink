import { ConfigService } from '@nestjs/config';
import { SensitiveDataService } from './sensitive-data.service';

describe('SensitiveDataService', () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const lookupKey = Buffer.alloc(32, 9).toString('base64');
  const service = new SensitiveDataService({
    getOrThrow: (name: string) =>
      name === 'PHONE_ENCRYPTION_KEY' ? encryptionKey : lookupKey,
  } as unknown as ConfigService);

  it('encrypts contact data and decrypts it without storing plaintext', () => {
    const value = service.encrypt('+525500000000');

    expect(value.ciphertext.toString('utf8')).not.toContain('+525500000000');
    expect(service.decrypt(value.ciphertext)).toBe('+525500000000');
  });

  it('detects tampering with authenticated ciphertext', () => {
    const value = service.encrypt('+525500000000');
    value.ciphertext[value.ciphertext.length - 1] ^= 0xff;

    expect(() => service.decrypt(value.ciphertext)).toThrow();
  });

  it('uses deterministic keyed lookups without exposing the phone number', () => {
    const digest = service.phoneLookup('+525500000000');

    expect(digest).toEqual(service.phoneLookup('+525500000000'));
    expect(digest).not.toEqual(service.phoneLookup('+525500000001'));
    expect(digest.toString('utf8')).not.toContain('+525500000000');
  });
});
