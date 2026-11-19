/**
 * A page's video as a share (docs/din/sharing.md): the share sheet's "Send
 * as" Video and Audio for a page the Web Browser can Download Video from.
 * Picking an app fetches it with yt-dlp into the share cache
 * (electron/video-download.mts, `forShare`), its progress in the sheet
 * (never on the browser's download shelf), then hands the file on; Save to
 * Downloads is Download Video as it always was.
 */
import type { BrowserBridge, DownloadInfo, VideoDownloadFormat } from '@/lib/browser';
import { mimeOf } from '@/lib/mime';
import type { ShareAlternative, ShareFile } from '@/lib/share';

/** Which page: a browser tab's (by its WebContents id), or any address. */
export type VideoSource = { wcId: number } | { url: string };

/** What the sheet remembers its last choice under, for every page with a video. */
export const VIDEO_SHARE_KEY = 'page-video';

/** The video's qualities as the sheet offers them: the best there is first. */
const VIDEO_QUALITIES: readonly { value: VideoDownloadFormat; label: string }[] = [
  { value: 'best', label: 'Best' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

/** An error's message without Electron's "Error invoking remote method" prefix. */
function bridgeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

function isFormat(value: string | null): value is VideoDownloadFormat {
  return value === 'audio' || VIDEO_QUALITIES.some((q) => q.value === value);
}

/**
 * Fetch a page's video into the share cache, resolving with the file once
 * it's there. Aborting `signal` cancels it.
 */
export function fetchVideoForShare(
  bridge: BrowserBridge,
  source: VideoSource,
  format: VideoDownloadFormat,
  onProgress: (progress: number | null) => void = () => {},
  signal?: AbortSignal,
): Promise<ShareFile> {
  return new Promise((resolve, reject) => {
    // Reports can come before the id does: keep each id's latest until it's known.
    const early = new Map<number, DownloadInfo>();
    let id: number | null = null;
    let done = false;
    const end = (fn: () => void) => {
      if (done) return;
      done = true;
      unsubscribe();
      fn();
    };
    const take = (info: DownloadInfo) => {
      if (info.state === 'progressing') {
        onProgress(info.totalBytes > 0 ? Math.min(1, info.receivedBytes / info.totalBytes) : null);
      } else if (info.state === 'completed') {
        const name = info.savePath.split('/').pop() || info.filename;
        end(() => resolve({ path: info.savePath, name, type: mimeOf(name) }));
      } else if (info.state === 'cancelled') {
        end(() => reject(new DOMException('Canceled', 'AbortError')));
      } else {
        end(() => reject(new Error(info.error ?? 'The video couldn’t be downloaded')));
      }
    };
    const unsubscribe = bridge.onDownload((info) => {
      if (id === null) early.set(info.id, info);
      else if (info.id === id) take(info);
    });
    signal?.addEventListener('abort', () => {
      if (id !== null) void bridge.cancelDownload(id).catch(() => {});
      end(() => reject(new DOMException('Canceled', 'AbortError')));
    }, { once: true });
    bridge.downloadVideo({ ...source, format, forShare: true }).then(
      (started) => {
        if (started === null) return end(() => reject(new Error('The video couldn’t be downloaded')));
        id = started;
        if (done) return void bridge.cancelDownload(started).catch(() => {});
        const seen = early.get(started);
        early.clear();
        if (seen) take(seen);
      },
      (error: unknown) => end(() => reject(new Error(bridgeMessage(error)))),
    );
  });
}

/** The sheet's Video and Audio for a page's video, from the Web Browser's tab or any address. */
export function videoShareAlternatives(bridge: BrowserBridge, source: VideoSource): ShareAlternative[] {
  const prepare = (fallback: VideoDownloadFormat): ShareAlternative['prepare'] => async (quality, onProgress, signal) => [
    await fetchVideoForShare(bridge, source, isFormat(quality) ? quality : fallback, onProgress, signal),
  ];
  const save = (fallback: VideoDownloadFormat) => (quality: string | null) => {
    void bridge.downloadVideo({ ...source, format: isFormat(quality) ? quality : fallback }).catch(() => {});
  };
  return [
    {
      id: 'video',
      label: 'Video',
      sample: { name: 'video.mp4', type: 'video/mp4' },
      qualities: VIDEO_QUALITIES,
      preparing: 'Preparing video',
      prepare: prepare('best'),
      save: save('best'),
    },
    {
      id: 'audio',
      label: 'Audio',
      sample: { name: 'audio.m4a', type: 'audio/mp4' },
      preparing: 'Preparing audio',
      prepare: prepare('audio'),
      save: save('audio'),
    },
  ];
}
