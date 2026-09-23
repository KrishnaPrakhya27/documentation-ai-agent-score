import dns, { type LookupAddress, type LookupOptions } from 'dns';

import { BlockedTargetError, isPublicAddress } from './publicAddress';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A DNS lookup for the HTTP agent that refuses any name resolving to a
 * non-public address. The socket connects to the address checked here, so a
 * name cannot pass the check and then rebind to an internal host.
 */
export function createPinnedLookup(
  isAllowedAddress: (address: string) => boolean = isPublicAddress,
) {
  return function pinnedLookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void {
    dns.lookup(
      hostname,
      { all: true, family: options.family, hints: options.hints },
      (error, addresses) => {
        if (error) {
          callback(error, options.all ? [] : '', 0);
          return;
        }
        const refused = addresses.find(
          (entry) => !isAllowedAddress(entry.address),
        );
        if (refused || addresses.length === 0) {
          const blocked = new BlockedTargetError(
            `${hostname} resolves to a non-public address`,
            'private_address',
          ) as BlockedTargetError & NodeJS.ErrnoException;
          callback(blocked, options.all ? [] : '', 0);
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      },
    );
  };
}
