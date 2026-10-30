import { useState, type FormEvent } from 'react';
import { nip19 } from 'nostr-tools';
import { AlertTriangle, Check, Copy, Loader2, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadFile } from '@/hooks/useUploadFile';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import {
  defaultNappletId,
  getWidgetsBridge,
  nappletManifestTemplate,
  parseFileWidget,
  type FileSource,
} from '@/lib/widgets';
import { NappletIcon } from './permissions';

type State =
  | { state: 'idle' }
  | { state: 'publishing'; step: string }
  | { state: 'done'; naddr: string }
  | { state: 'error'; message: string };

/** A data: URL's bytes and type. */
function decodeDataUrl(url: string): { bytes: Uint8Array; type: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  const binary = atob(match[2]);
  return { bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)), type: match[1] };
}

/**
 * Publish to Nostr…: a folder's widget as a napplet (NIP-5D), its page as it
 * runs here (and its icon) on the user's Blossom servers, and a kind 35129
 * manifest naming them, signed by the user.
 */
export function PublishWidget({ source, onClose }: { source: FileSource | null; onClose: () => void }) {
  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {source && <PublishForm key={source.path} source={source} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({ source, onClose }: { source: FileSource; onClose: () => void }) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const upload = useUploadFile();
  const publish = useNostrPublish();
  const [dTag, setDTag] = useState(() => defaultNappletId(source));
  const [state, setState] = useState<State>({ state: 'idle' });
  const [copied, setCopied] = useState(false);
  const domains = [...source.requires, ...source.optional];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bridge = getWidgetsBridge();
    const identifier = dTag.trim();
    if (!bridge || !user || !identifier) return;
    try {
      // The page as it is now, byte for byte what will be published.
      setState({ state: 'publishing', step: 'Reading the folder…' });
      const opened = await bridge.folder(source.path);
      const fresh = parseFileWidget(opened);
      if (!fresh.description) throw new Error('Give it a description first: <meta name="description" content="…"> in index.html.');

      setState({ state: 'publishing', step: 'Uploading the widget…' });
      const pageTags = await upload.mutateAsync(new File([opened.html], 'index.html', { type: 'text/html' }));
      const sha256 = pageTags.find(([name]) => name === 'x')?.[1];
      if (!sha256) throw new Error('The Blossom server didn\'t say what it stored.');

      let icon: { sha256: string; type: string } | undefined;
      const iconData = fresh.icon ? decodeDataUrl(fresh.icon) : null;
      if (iconData) {
        setState({ state: 'publishing', step: 'Uploading its icon…' });
        const iconTags = await upload.mutateAsync(new File([iconData.bytes as BlobPart], 'icon', { type: iconData.type }));
        const iconHash = iconTags.find(([name]) => name === 'x')?.[1];
        if (iconHash) icon = { sha256: iconHash, type: iconData.type };
      }

      setState({ state: 'publishing', step: 'Signing…' });
      const servers = [
        ...getEffectiveBlossomServers(config.blossomServerMetadata, config.useAppBlossomServers),
        ...fresh.servers,
      ];
      const event = await publish.mutateAsync(nappletManifestTemplate(fresh, { dTag: identifier, sha256, servers, icon }));
      setState({ state: 'done', naddr: nip19.naddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier }) });
    } catch (error) {
      const message = error instanceof AggregateError
        ? 'None of your Blossom servers would take it.'
        : error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
      setState({ state: 'error', message });
    }
  };

  const copy = (naddr: string) => {
    void navigator.clipboard.writeText(naddr).then(() => setCopied(true));
  };

  if (state.state === 'done') {
    return (
      <>
        <DialogHeader className="items-center text-center sm:text-center">
          <span className="grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Check className="size-7" aria-hidden />
          </span>
          <DialogTitle className="text-xl">{source.title} is on Nostr</DialogTitle>
          <DialogDescription>
            Anyone can add it from Add Widgets → From Nostr with this address. Publishing again under the same
            identifier updates it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={state.naddr} aria-label="Widget address" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="secondary" onClick={() => copy(state.naddr)}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <Button className="w-full" onClick={onClose}>Done</Button>
      </>
    );
  }

  const busy = state.state === 'publishing';
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <DialogHeader className="items-center text-center sm:text-center">
        <NappletIcon source={source} className="size-16 text-2xl" />
        <DialogTitle className="text-xl">Publish {source.title} to Nostr</DialogTitle>
        <DialogDescription className="whitespace-pre-line">
          {source.description || 'It has no description yet. Add <meta name="description" content="…"> to its index.html.'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="napplet-id">Identifier</Label>
        <Input
          id="napplet-id"
          value={dTag}
          onChange={(e) => setDTag(e.target.value)}
          spellCheck={false}
          disabled={busy}
          className="font-mono"
        />
        <p className="text-sm text-muted-foreground">
          {source.dTag
            ? 'From its napplet-id. Publishing under the same identifier again replaces it.'
            : 'Add <meta name="napplet-id"> to its index.html to keep this with it. Publishing under the same identifier again replaces it.'}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Asks for</dt>
        <dd>{domains.length > 0 ? domains.join(', ') : 'Nothing'}</dd>
        {source.source && (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="min-w-0 break-all">{source.source}</dd>
          </>
        )}
      </dl>
      {!user && <p className="text-sm text-muted-foreground">Sign in to publish widgets.</p>}
      {state.state === 'error' && (
        <p className="flex gap-2 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.message}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full rounded-full" disabled={busy || !user || !dTag.trim() || !source.description}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Share aria-hidden />}
        {busy ? state.step : 'Publish'}
      </Button>
    </form>
  );
}
