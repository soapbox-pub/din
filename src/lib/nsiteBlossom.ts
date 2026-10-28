import type { NostrEvent } from '@nostrify/nostrify';
import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import type { NsiteFileSource } from '@/lib/nsiteAppInfo';

/** How long one Blossom server gets before the next is tried. */
const BLOB_TIMEOUT_MS = 8000;

/** Hex sha256, as a manifest's `path` tags carry it. */
const HASH_RE = /^[0-9a-f]{64}$/;

/** Path -> sha256 for every file a manifest names. */
export function manifestPaths(event: NostrEvent): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [name, path, hash] of event.tags) {
    if (name !== 'path' || !path?.startsWith('/') || !HASH_RE.test(hash ?? '')) continue;
    paths[path] = hash;
  }
  return paths;
}

/**
 * The servers to fetch a site's blobs from: the manifest's own hints, then
 * Din's defaults. https only, since the list comes off a stranger's event.
 */
function serversOf(event: NostrEvent): string[] {
  const tagged = event.tags.filter(([name]) => name === 'server').map(([, url]) => url);
  const out = new Set<string>();
  for (const raw of [...tagged, ...APP_BLOSSOM_SERVERS.servers]) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') out.add(url.href.endsWith('/') ? url.href : `${url.href}/`);
    } catch {
      // Not a URL.
    }
  }
  return [...out];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read a site's files straight from Blossom, for a site Din's nsite store
 * doesn't keep (or where there is no store, in a plain browser). Each blob is
 * checked against the hash in the signed manifest; a server that answers with
 * anything else is skipped.
 */
export function blossomFileSource(event: NostrEvent): NsiteFileSource {
  const paths = manifestPaths(event);
  const servers = serversOf(event);
  const readBlob = async (hash: string): Promise<Uint8Array | null> => {
    if (!HASH_RE.test(hash)) return null;
    for (const server of servers) {
      try {
        const response = await fetch(new URL(hash, server), {
          credentials: 'omit',
          signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if ((await sha256Hex(bytes)) === hash) return bytes;
      } catch {
        // Network error or timeout: try the next server.
      }
    }
    return null;
  };
  return {
    paths,
    read: async (path) => (paths[path] ? readBlob(paths[path]) : null),
    readBlob,
  };
}
