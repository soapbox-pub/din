import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { fileUrl } from '@/lib/fs';
import { cn } from '@/lib/utils';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** The local path of a `file:` URI, or null. */
function pathOfFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

/**
 * Where to load a picture from, when an attachment is one: a pasted
 * picture's data, or the file it names on this computer.
 */
function useAttachmentImage(file: { uri?: string; mime?: string; data?: string; name?: string }): string | null {
  const { uri, mime, data, name } = file;
  const inline = data && mime?.startsWith('image/') ? `data:${mime};base64,${data}` : null;
  const path = !inline && uri ? pathOfFileUri(uri) : null;
  const local = path && (mime ? mime.startsWith('image/') : IMAGE_EXTENSIONS.test(name ?? path)) ? path : null;
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!local) return;
    let live = true;
    fileUrl(local).then(
      (url) => live && setLoaded({ path: local, url }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [local]);
  if (inline) return inline;
  if (uri?.startsWith('data:image/')) return uri;
  return local && loaded?.path === local ? loaded.url : null;
}

/** A picture shown big over everything, until clicked or Escape. */
export function ImageLightbox({
  src,
  name,
  open,
  onOpenChange,
}: {
  src: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[calc(100%-2rem)] w-auto max-w-[calc(100%-2rem)] place-items-center border-none bg-transparent p-0 shadow-none sm:max-w-[calc(100%-2rem)]"
        showCloseButton={false}
        onClick={() => onOpenChange(false)}
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <DialogPrimitive.Description className="sr-only">An attached picture</DialogPrimitive.Description>
        <img
          src={src}
          alt={name}
          draggable={false}
          className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] rounded-lg object-contain shadow-2xl"
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A picture attachment as a thumbnail that opens in a lightbox; anything
 * else (or a picture that won't load) as a chip with its name.
 */
export function AttachmentItem({
  file,
  className,
  compact,
  onRemove,
}: {
  file: { uri?: string; mime?: string; data?: string; name?: string };
  className?: string;
  /** A smaller thumbnail, as in the composer. */
  compact?: boolean;
  /** The composer's: take it off the message. */
  onRemove?: () => void;
}) {
  const src = useAttachmentImage(file);
  const [broken, setBroken] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const name = file.name ?? file.mime ?? 'Attachment';
  const remove = onRemove && (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${name}`}
      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-3" aria-hidden />
    </button>
  );

  if (src && broken !== src) {
    return (
      <li className={cn('group/attachment relative', className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`View ${name}`}
          title={name}
          className="block overflow-hidden rounded-xl bg-card clay transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src={src}
            alt={name}
            draggable={false}
            onError={() => setBroken(src)}
            className={cn('block object-contain', compact ? 'max-h-20 max-w-32' : 'max-h-40 max-w-56')}
          />
        </button>
        {remove && <div className="absolute right-1 top-1 rounded bg-background/90 shadow-sm">{remove}</div>}
        <ImageLightbox src={src} name={name} open={open} onOpenChange={setOpen} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'flex max-w-56 items-center gap-1.5 rounded-xl bg-card clay px-2 py-1 text-xs text-muted-foreground',
        remove && 'pr-1',
        className,
      )}
    >
      <FileText className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate" title={name}>
        {name}
      </span>
      {remove}
    </li>
  );
}
