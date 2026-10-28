import { useCallback } from 'react';
import { useUploadFile } from '@/hooks/useUploadFile';
import { getFsBridge } from '@/lib/fs';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/** The biggest picture uploaded for a theme's background. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Uploads a picture on this computer to the user's Blossom servers, where
 * anyone can see it, for a theme that goes on Nostr. Resolves to its https
 * URL.
 */
export function useUploadLocalPicture(): (path: string, mimeType: string) => Promise<string> {
  const { mutateAsync: upload } = useUploadFile();
  return useCallback(
    async (path: string, mimeType: string) => {
      const fs = getFsBridge();
      if (!fs) throw new Error('Pictures on this computer need the Din shell.');
      const { data, truncated } = await fs.readFile(path, MAX_UPLOAD_BYTES);
      if (truncated) throw new Error('The picture is too big to upload.');
      const name = path.slice(path.lastIndexOf('/') + 1);
      const tags = await upload(new File([new Uint8Array(data)], name, { type: mimeType }));
      const url = sanitizeUrl(tags.find(([tag]) => tag === 'url')?.[1] ?? '');
      if (!url) throw new Error('The upload gave back no address for the picture.');
      return url;
    },
    [upload],
  );
}
