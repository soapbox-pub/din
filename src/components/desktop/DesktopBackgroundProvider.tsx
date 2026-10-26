import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DesktopBackgroundContext,
  type DesktopBackgroundContextValue,
  type DesktopBackgroundSource,
} from '@/contexts/DesktopBackgroundContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useDesktopThemeEditor } from '@/hooks/useDesktopTheme';
import { useToast } from '@/hooks/useToast';
import { useUploadFile } from '@/hooks/useUploadFile';
import { getColorSchemeBridge } from '@/lib/colorScheme';
import { cleanFsError, getFsBridge, joinPath, localFileUrl, parentPath } from '@/lib/fs';
import { isLocalBackground, type DesktopTheme } from '@/lib/profileTheme';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/** The pictures a background can be, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/** Where pictures used on this computer only are kept, under the home folder. */
const BACKGROUNDS_DIR = '.local/share/din/backgrounds';

/** The biggest picture uploaded as a background. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function imageType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : (IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null);
}

/** The type of the picture at an https URL: by its name, else as served. */
async function remoteImageType(url: string): Promise<string> {
  const byName = imageType(new URL(url).pathname);
  if (byName) return byName;
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    if (type?.startsWith('image/')) return type;
  } catch {
    // Unreachable without CORS: assume the common case.
  }
  return 'image/jpeg';
}

function withBackground(theme: DesktopTheme, url: string, mimeType: string): DesktopTheme {
  return { ...theme, background: { url, mimeType, mode: theme.background?.mode ?? 'cover' } };
}

/** The local path of a background on this computer. */
function localPath(url: string): string {
  return decodeURIComponent(new URL(url).pathname);
}

/**
 * Sets the desktop background, for the desktop's right-click menu, Settings,
 * Files, Preview, and "Set Image as Desktop Background" in web pages.
 *
 * A picture on this computer is copied under ~/.local/share/din/backgrounds
 * for a theme kept here, so it stays when the original moves. One going into
 * a synced profile theme has to be uploaded to the user's Blossom servers,
 * where anyone can see it, so that waits for the user to agree, or to keep
 * it on this computer instead.
 */
export function DesktopBackgroundProvider({ children }: { children: ReactNode }) {
  const editor = useDesktopThemeEditor();
  const { config } = useAppContext();
  const { pickFile } = useFilePicker();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const { mutateAsync: upload } = useUploadFile();

  /** A local picture waiting on the upload question. */
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'local' | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      toast({
        title: "Couldn't set the background",
        description: cleanFsError(error),
        variant: 'destructive',
      });
    },
    [toast],
  );

  const localThemeBackground = config.localTheme?.background?.url;

  /** Copy a picture to keep and wear it in this computer's theme. */
  const keepLocal = useCallback(
    async (path: string, mimeType: string) => {
      const fs = getFsBridge();
      if (!fs) throw new Error('Pictures on this computer need the Din shell.');
      const dir = joinPath(await fs.homedir(), BACKGROUNDS_DIR);
      let kept = path;
      if (parentPath(path) !== dir) {
        await fs.mkdir(dir);
        kept = await fs.copyInto(path, dir);
      }
      editor.applyLocal(withBackground(editor.base(), localFileUrl(kept), mimeType));

      // The copy of the picture this replaces isn't needed any more.
      if (localThemeBackground && isLocalBackground(localThemeBackground)) {
        const previous = localPath(localThemeBackground);
        if (previous !== kept && parentPath(previous) === dir) {
          fs.rm(previous).catch(() => {});
        }
      }
    },
    [editor, localThemeBackground],
  );

  /** Upload a picture and wear it in the profile theme. */
  const uploadAndApply = useCallback(
    async (path: string, mimeType: string) => {
      const fs = getFsBridge();
      if (!fs) throw new Error('Pictures on this computer need the Din shell.');
      const { data, truncated } = await fs.readFile(path, MAX_UPLOAD_BYTES);
      if (truncated) throw new Error('The picture is too big to upload.');
      const name = path.slice(path.lastIndexOf('/') + 1);
      const tags = await upload(new File([new Uint8Array(data)], name, { type: mimeType }));
      const url = sanitizeUrl(tags.find(([tag]) => tag === 'url')?.[1] ?? '');
      if (!url) throw new Error('The upload gave back no address for the picture.');
      editor.apply(withBackground(editor.base(), url, mimeType));
    },
    [editor, upload],
  );

  const setBackground = useCallback(
    async (source: DesktopBackgroundSource) => {
      try {
        if ('url' in source) {
          const url = sanitizeUrl(source.url);
          if (!url) throw new Error('Only https pictures can be a background.');
          editor.apply(withBackground(editor.base(), url, await remoteImageType(url)));
          toast({ title: 'Desktop background changed' });
          return;
        }
        const mimeType = imageType(source.path);
        if (!mimeType) throw new Error("That file isn't a picture Din can show.");
        if (editor.syncing) setPending(source.path);
        else await keepLocal(source.path, mimeType);
      } catch (error) {
        fail(error);
      }
    },
    [editor, keepLocal, toast, fail],
  );

  const chooseBackground = useCallback(async () => {
    if (!getFsBridge()) {
      open('settings', { section: 'appearance' });
      return;
    }
    const path = await pickFile({
      title: 'Choose a desktop background',
      confirmLabel: 'Set Background',
      extensions: Object.keys(IMAGE_TYPES),
    });
    if (path) await setBackground({ path });
  }, [open, pickFile, setBackground]);

  // "Set Image as Desktop Background" in a page's right-click menu.
  const setBackgroundRef = useRef(setBackground);
  useEffect(() => {
    setBackgroundRef.current = setBackground;
  }, [setBackground]);
  useEffect(
    () => getColorSchemeBridge()?.onSetBackground((url) => void setBackgroundRef.current({ url })),
    [],
  );

  const answer = async (how: 'upload' | 'local') => {
    const path = pending;
    const mimeType = path && imageType(path);
    if (!path || !mimeType) return;
    setBusy(how);
    try {
      if (how === 'upload') await uploadAndApply(path, mimeType);
      else await keepLocal(path, mimeType);
      setPending(null);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const value: DesktopBackgroundContextValue = useMemo(
    () => ({ chooseBackground, setBackground }),
    [chooseBackground, setBackground],
  );

  return (
    <DesktopBackgroundContext.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setPending(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload this picture?</DialogTitle>
            <DialogDescription>
              Your theme syncs with your Nostr profile, so this picture would be uploaded to your
              Blossom servers, where anyone can see it. To keep it private, use it on this computer
              only. Your theme here then stops syncing with your profile.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" disabled={busy !== null} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void answer('local')}>
              {busy === 'local' && <Loader2 className="animate-spin" aria-hidden />}
              This Computer Only
            </Button>
            <Button disabled={busy !== null} onClick={() => void answer('upload')}>
              {busy === 'upload' && <Loader2 className="animate-spin" aria-hidden />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DesktopBackgroundContext.Provider>
  );
}
