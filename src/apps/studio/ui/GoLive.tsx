import { useEffect, useState } from 'react';
import { Check, Loader2, MoreHorizontal, Pencil, Plus, Radio, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cleanCaptureError, type CaptureBridge, type Destination, type DestinationService } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { Segmented } from './Segmented';

interface Service {
  name: string;
  /** Its ingest server, when it's the same for everyone. */
  server: string;
  /** Where to find the key (and the server, when it isn't fixed). */
  help: string;
  color: string;
}

const SERVICES: Record<DestinationService, Service> = {
  youtube: {
    name: 'YouTube',
    server: 'rtmp://a.rtmp.youtube.com/live2',
    help: 'In YouTube Studio, choose Create › Go live › Stream, and copy the stream key.',
    color: 'bg-red-600',
  },
  twitch: {
    name: 'Twitch',
    server: 'rtmp://live.twitch.tv/app',
    help: 'In Twitch’s Creator Dashboard, open Settings › Stream and copy the primary stream key.',
    color: 'bg-violet-600',
  },
  kick: {
    name: 'Kick',
    server: '',
    help: 'In Kick’s Dashboard, open Settings › Stream URL & Key, and copy both.',
    color: 'bg-lime-500',
  },
  custom: {
    name: 'Custom',
    server: '',
    help: 'Any service that takes RTMP: paste its server address and stream key.',
    color: 'bg-neutral-500',
  },
};

function ServiceBadge({ service }: { service: DestinationService }) {
  return (
    <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white', SERVICES[service].color)}>
      {SERVICES[service].name[0]}
    </span>
  );
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** Adding or changing a destination. */
function DestinationForm({
  capture,
  editing,
  onSaved,
  onCancel,
}: {
  capture: CaptureBridge;
  editing: Destination | null;
  onSaved: (destination: Destination) => void;
  onCancel: (() => void) | null;
}) {
  const [service, setService] = useState<DestinationService>(editing?.service ?? 'youtube');
  const [server, setServer] = useState(editing?.server ?? SERVICES.youtube.server);
  const [key, setKey] = useState('');
  const [name, setName] = useState(editing?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixed = SERVICES[service].server !== '';

  const choose = (next: DestinationService) => {
    setService(next);
    setServer(SERVICES[next].server);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await capture.saveDestination({
        id: editing?.id,
        service,
        name: name.trim() || SERVICES[service].name,
        server: server.trim(),
        key: key.trim() || undefined,
      });
      onSaved(saved);
    } catch (e) {
      setError(cleanCaptureError(e));
    } finally {
      setSaving(false);
    }
  };

  const needsKey = service !== 'custom' && !editing?.hasKey;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Segmented
        label="Service"
        value={service}
        onChange={choose}
        segments={(Object.keys(SERVICES) as DestinationService[]).map((s) => ({ value: s, label: SERVICES[s].name }))}
        className="self-start"
      />
      <p className="text-sm text-muted-foreground">{SERVICES[service].help}</p>
      {!fixed && (
        <div className="grid gap-1.5">
          <Label htmlFor="studio-server">Server</Label>
          <Input id="studio-server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="rtmps://…" autoComplete="off" spellCheck={false} />
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="studio-key">Stream key</Label>
        <Input
          id="studio-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={editing?.hasKey ? 'Saved; paste a new one to change it' : 'Paste the stream key'}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">Kept on this computer in your keyring, and only ever sent to {SERVICES[service].name === 'Custom' ? 'that server' : SERVICES[service].name}.</p>
      </div>
      {service === 'custom' && (
        <div className="grid gap-1.5">
          <Label htmlFor="studio-name">Name</Label>
          <Input id="studio-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="zap.stream, Restream…" />
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={saving || !server.trim() || (needsKey && !key.trim())}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {editing ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

function DestinationRow({
  destination,
  selected,
  onSelect,
  onEdit,
  onRemove,
}: {
  destination: Destination;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="radio"
          aria-checked={selected}
          tabIndex={0}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect();
            }
          }}
          className={cn(
            'group flex cursor-default items-center gap-3 rounded-xl p-3 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60',
            selected && 'bg-selected',
          )}
        >
          <ServiceBadge service={destination.service} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{destination.name}</p>
            <p className="truncate text-xs text-muted-foreground">{destination.hasKey || destination.service === 'custom' ? hostOf(destination.server) : 'No stream key yet'}</p>
          </div>
          {selected && <Check className="size-4.5 text-ink-accent" strokeWidth={1.75} aria-hidden />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More for ${destination.name}`}
                onClick={(e) => e.stopPropagation()}
                className="grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-foreground/[0.07] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="size-4.5" strokeWidth={1.75} aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onEdit}>
          <Pencil className="size-4.5" strokeWidth={1.75} aria-hidden />
          Edit
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
          Remove
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Where to stream, and going live. */
export function GoLiveDialog({
  open,
  onOpenChange,
  capture,
  selected,
  onSelect,
  recordWhileLive,
  onRecordWhileLive,
  recording,
  onGoLive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capture: CaptureBridge;
  selected: string;
  onSelect: (id: string) => void;
  recordWhileLive: boolean;
  onRecordWhileLive: (on: boolean) => void;
  /** A take is already being recorded. */
  recording: boolean;
  onGoLive: (destination: string) => Promise<void>;
}) {
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [form, setForm] = useState<{ editing: Destination | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mounted as it opens, so each opening starts fresh.
  useEffect(() => {
    let live = true;
    capture.destinations().then((list) => live && setDestinations(list), () => live && setDestinations([]));
    return () => {
      live = false;
    };
  }, [capture]);

  const list = destinations ?? [];
  const chosen = list.find((d) => d.id === selected) ?? list[0];
  const showForm = form !== null || (destinations !== null && list.length === 0);

  const go = async () => {
    if (!chosen) return;
    setStarting(true);
    setError(null);
    try {
      onSelect(chosen.id);
      await onGoLive(chosen.id);
      onOpenChange(false);
    } catch (e) {
      setError(cleanCaptureError(e));
    } finally {
      setStarting(false);
    }
  };

  const remove = async (d: Destination) => {
    await capture.removeDestination(d.id).catch(() => {});
    setDestinations((all) => (all ?? []).filter((x) => x.id !== d.id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{showForm ? (form?.editing ? `Edit ${form.editing.name}` : 'Add a place to stream') : 'Go Live'}</DialogTitle>
          <DialogDescription>
            {showForm ? 'Studio streams what you see in its picture, with your microphone.' : 'Stream what you see in Studio’s picture, with your microphone.'}
          </DialogDescription>
        </DialogHeader>

        {destinations === null ? (
          <div className="grid h-24 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        ) : showForm ? (
          <DestinationForm
            capture={capture}
            editing={form?.editing ?? null}
            onCancel={list.length > 0 ? () => setForm(null) : null}
            onSaved={(saved) => {
              setDestinations((all) => {
                const rest = (all ?? []).filter((d) => d.id !== saved.id);
                return [...rest, saved];
              });
              onSelect(saved.id);
              setForm(null);
            }}
          />
        ) : (
          <>
            <div role="radiogroup" aria-label="Destination" className="flex flex-col gap-2">
              {list.map((d) => (
                <DestinationRow
                  key={d.id}
                  destination={d}
                  selected={d.id === chosen?.id}
                  onSelect={() => onSelect(d.id)}
                  onEdit={() => setForm({ editing: d })}
                  onRemove={() => void remove(d)}
                />
              ))}
            </div>
            <Button variant="ghost" className="self-start" onClick={() => setForm({ editing: null })}>
              <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
              Add a place to stream
            </Button>
            <div className="flex items-center justify-between gap-4 rounded-xl bg-card px-4 py-3 clay">
              <Label htmlFor="studio-record-live" className="flex-1 text-sm font-normal">
                Save a take of the stream too
                {recording && <span className="block text-xs text-muted-foreground">A take is already being recorded.</span>}
              </Label>
              <Switch id="studio-record-live" checked={recordWhileLive && !recording} disabled={recording} onCheckedChange={onRecordWhileLive} />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void go()} disabled={!chosen || starting || (!chosen.hasKey && chosen.service !== 'custom')} className="bg-red-600 text-white hover:bg-red-700">
                {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Radio className="size-4.5" strokeWidth={1.75} aria-hidden />}
                Go Live{chosen ? ` on ${chosen.name}` : ''}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
