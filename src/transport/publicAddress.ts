import ipaddr from 'ipaddr.js';

/**
 * Decides whether a URL or address is somewhere the scanner may send a request.
 * Anyone on the internet chooses the URL, so only public unicast addresses on
 * web ports pass, and every redirect hop is checked again by the caller.
 */

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const PRIVATE_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.corp',
];

export type BlockedTargetCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'blocked_port'
  | 'private_address'
  | 'unresolvable_host';

export class BlockedTargetError extends Error {
  constructor(
    message: string,
    readonly code: BlockedTargetCode,
  ) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

/** True only for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);

  if (parsed.kind() === 'ipv4') return parsed.range() === 'unicast';

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) {
    return ipv6.toIPv4Address().range() === 'unicast';
  }
  // ::a.b.c.d (IPv4-compatible) is deprecated and never public; ipaddr.js
  // calls it unicast. 64:ff9b:1::/48 is the local-use NAT64 prefix.
  const [p0, p1, p2, p3, p4, p5] = ipv6.parts;
  if (p0 === 0 && p1 === 0 && p2 === 0 && p3 === 0 && p4 === 0 && p5 === 0) {
    return false;
  }
  if (p0 === 0x64 && p1 === 0xff9b && p2 === 1) return false;

  return ipv6.range() === 'unicast';
}

/** Parses and checks everything knowable without DNS; throws BlockedTargetError. */
export function assertFetchableUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : new URL(raw.href);
  } catch {
    throw new BlockedTargetError(`"${String(raw)}" is not a URL`, 'invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(
      `Only http and https URLs can be scanned, not ${url.protocol}`,
      'unsupported_scheme',
    );
  }
  if (url.username || url.password) {
    throw new BlockedTargetError(
      'URLs with a username or password cannot be scanned',
      'credentials_in_url',
    );
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new BlockedTargetError(
      `Port ${url.port} is not a web port the scanner uses`,
      'blocked_port',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new BlockedTargetError(
        `${hostname} is not a public address`,
        'private_address',
      );
    }
    return url;
  }

  if (
    !hostname.includes('.') ||
    PRIVATE_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.replace(/^\./, '') || hostname.endsWith(suffix),
    )
  ) {
    throw new BlockedTargetError(
      `${hostname} is not a public host name`,
      'private_address',
    );
  }

  return url;
}
