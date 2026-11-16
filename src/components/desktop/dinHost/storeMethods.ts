import type { Requests } from '@/sdk/protocol';

/** din.store's requests, and what the desktop's StoreHost answers them with. */
export type StoreMethod = Extract<keyof Requests, `store.${string}`>;
export type StoreHandlers = { [M in StoreMethod]: (params: Requests[M][0]) => Promise<Requests[M][1]> };

/** Every din.store request, which DinAppFrame hands to StoreHost (a record, so one left out doesn't type-check). */
const STORE_METHOD_SET: Record<StoreMethod, true> = {
  'store.state': true,
  'store.install': true,
  'store.use': true,
  'store.remove': true,
  'store.open': true,
  'store.tryOn': true,
  'store.endTryOn': true,
  'store.themes.tryOn': true,
  'store.themes.stopTrying': true,
  'store.themes.use': true,
  'store.themes.revert': true,
  'store.themes.done': true,
  'store.themes.removeFromLibrary': true,
  'store.deletePublished': true,
  'store.publishSkin': true,
  'store.addFolderApp': true,
};
export const STORE_METHODS = Object.keys(STORE_METHOD_SET) as StoreMethod[];
