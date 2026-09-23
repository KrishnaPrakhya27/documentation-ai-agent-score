import { describe, expect, it } from 'vitest';

import { createPinnedLookup } from '../transport/pinnedLookup';
import {
  assertFetchableUrl,
  BlockedTargetError,
  isPublicAddress,
} from '../transport/publicAddress';

/**
 * The address guard is what stops a submitted URL from reaching our own
 * network. Cases include the IPv6 spellings that ipaddr.js alone calls
 * public, and every case is offline: literals and localhost need no DNS.
 */

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '::a00:1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:0:7f00:1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('assertFetchableUrl', () => {
  it.each([
    ['ftp://docs.example.com/', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['https://user:secret@docs.example.com/', 'credentials_in_url'],
    ['https://docs.example.com:22/', 'blocked_port'],
    ['http://docs.example.com:6379/', 'blocked_port'],
    ['http://localhost/', 'private_address'],
    ['http://printer.local/', 'private_address'],
    ['http://metadata.google.internal/', 'private_address'],
    ['http://intranet/', 'private_address'],
    ['http://127.0.0.1/', 'private_address'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'],
    ['http://[::1]/', 'private_address'],
    ['http://[::ffff:127.0.0.1]/', 'private_address'],
    ['http://[::7f00:1]/', 'private_address'],
    ['not a url', 'invalid_url'],
  ])('refuses %s (%s)', (url, code) => {
    try {
      assertFetchableUrl(url);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BlockedTargetError);
      expect((error as BlockedTargetError).code).toBe(code);
    }
  });

  it.each([
    'https://docs.example.com/',
    'http://docs.example.com:8080/guide',
    'https://93.184.216.34/',
  ])('allows %s', (url) => {
    expect(assertFetchableUrl(url).href).toBe(new URL(url).href);
  });
});

describe('createPinnedLookup', () => {
  it('refuses a name that resolves to loopback', async () => {
    const lookup = createPinnedLookup();
    const error = await new Promise<unknown>((resolve) =>
      lookup('localhost', { all: true }, (err) => resolve(err)),
    );
    expect(error).toBeInstanceOf(BlockedTargetError);
  });

  it('hands every address back when the policy allows them', async () => {
    const lookup = createPinnedLookup(() => true);
    const addresses = await new Promise<unknown>((resolve, reject) =>
      lookup('localhost', { all: true }, (err, result) =>
        err ? reject(err) : resolve(result),
      ),
    );
    expect(Array.isArray(addresses)).toBe(true);
    expect((addresses as unknown[]).length).toBeGreaterThan(0);
  });
});
