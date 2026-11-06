import { useState, useEffect } from 'react';
import { Copy, Plus, X, Wifi, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { normalizeRelayUrl, relayListTags } from '@/lib/relayLists';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsToken } from '@/shared/settingsChrome';

interface Relay {
  url: string;
  read: boolean;
  write: boolean;
}

export function RelayListManager() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutate: publishEvent } = useNostrPublish();
  const { toast } = useToast();

  const [relays, setRelays] = useState<Relay[]>(config.relayMetadata.relays);
  const [newRelayUrl, setNewRelayUrl] = useState('');

  // Sync local state with config when it changes (e.g., from NostrProvider sync).
  // This is a legitimate "mirror external source of truth" pattern: the local
  // `relays` state is what the UI edits optimistically, and we need to reset
  // it when the authoritative config changes from outside.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRelays(config.relayMetadata.relays);
  }, [config.relayMetadata.relays]);

  const isValidRelayUrl = (url: string): boolean => {
    const trimmed = url.trim();
    if (!trimmed) return false;

    const normalized = normalizeRelayUrl(trimmed);
    try {
      new URL(normalized);
      return true;
    } catch {
      return false;
    }
  };

  const handleAddRelay = () => {
    if (!isValidRelayUrl(newRelayUrl)) {
      toast({
        title: 'Invalid relay URL',
        description: 'Please enter a valid relay URL (e.g., wss://relay.example.com)',
        variant: 'destructive',
      });
      return;
    }

    const normalized = normalizeRelayUrl(newRelayUrl);

    if (relays.some(r => r.url === normalized)) {
      toast({
        title: 'Relay already exists',
        description: 'This relay is already in your list.',
        variant: 'destructive',
      });
      return;
    }

    const newRelays = [...relays, { url: normalized, read: true, write: true }];
    setRelays(newRelays);
    setNewRelayUrl('');

    saveRelays(newRelays);
  };

  const handleRemoveRelay = (url: string) => {
    const newRelays = relays.filter(r => r.url !== url);
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const handleToggleRead = (url: string) => {
    const newRelays = relays.map(r =>
      r.url === url ? { ...r, read: !r.read } : r
    );
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const handleToggleWrite = (url: string) => {
    const newRelays = relays.map(r =>
      r.url === url ? { ...r, write: !r.write } : r
    );
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => toast({ title: 'URL copied' }),
      () => toast({ title: "Couldn't copy the URL", variant: 'destructive' }),
    );
  };

  const saveRelays = (newRelays: Relay[]) => {
    // Only called from event handlers, not during render, so Date.now() is safe.
    // eslint-disable-next-line react-hooks/purity
    const now = Math.floor(Date.now() / 1000);

    // Update local config
    updateConfig((current) => ({
      ...current,
      relayMetadata: {
        relays: newRelays,
        updatedAt: now,
      },
    }));

    // Publish to Nostr if user is logged in
    if (user) {
      publishNIP65RelayList(newRelays);
    }
  };

  const publishNIP65RelayList = (relayList: Relay[]) => {
    const tags = relayListTags(relayList);

    publishEvent(
      {
        kind: 10002,
        content: '',
        tags,
      },
      {
        onSuccess: () => {
          toast({
            title: 'Relay list published',
            description: 'Your relay list has been published to Nostr.',
          });
        },
        onError: (error) => {
          console.error('Failed to publish relay list:', error);
          toast({
            title: 'Failed to publish relay list',
            description: 'There was an error publishing your relay list to Nostr.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const renderRelayUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'wss:') {
        if (parsed.pathname === '/') {
          return parsed.host;
        } else {
          return parsed.host + parsed.pathname;
        }
      } else {
        return parsed.href;
      }
    } catch {
      return url;
    }
  }

  return (
    <div className="space-y-4">
      {/* Relay List */}
      <div className={settingsGroup}>
        {relays.map((relay) => (
          <ContextMenu key={relay.url}>
            <ContextMenuTrigger asChild>
              <div className="flex items-center gap-3 py-2 pr-2 pl-4">
                <SettingsToken icon={Wifi} />
                <span className="font-mono text-sm flex-1 truncate" title={relay.url}>
                  {renderRelayUrl(relay.url)}
                </span>

                {/* Settings Popover */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Settings for ${renderRelayUrl(relay.url)}`}
                    >
                      <Settings className="size-4.5" strokeWidth={1.75} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48" align="end">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`read-${relay.url}`} className="text-sm cursor-pointer">
                          Read
                        </Label>
                        <Switch
                          id={`read-${relay.url}`}
                          checked={relay.read}
                          onCheckedChange={() => handleToggleRead(relay.url)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`write-${relay.url}`} className="text-sm cursor-pointer">
                          Write
                        </Label>
                        <Switch
                          id={`write-${relay.url}`}
                          checked={relay.write}
                          onCheckedChange={() => handleToggleWrite(relay.url)}
                        />
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Remove Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveRelay(relay.url)}
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${renderRelayUrl(relay.url)}`}
                  disabled={relays.length <= 1}
                >
                  <X className="size-4.5" strokeWidth={1.75} />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuCheckboxItem checked={relay.read} onCheckedChange={() => handleToggleRead(relay.url)}>
                Read
              </ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={relay.write} onCheckedChange={() => handleToggleWrite(relay.url)}>
                Write
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => copyUrl(relay.url)}>
                <Copy aria-hidden />
                Copy URL
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                disabled={relays.length <= 1}
                onSelect={() => handleRemoveRelay(relay.url)}
              >
                <X aria-hidden />
                Remove
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>

      {/* Add Relay Form */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Label htmlFor="new-relay-url" className="sr-only">
            Relay URL
          </Label>
          <Input
            id="new-relay-url"
            placeholder="Enter relay URL (e.g., wss://relay.example.com)"
            value={newRelayUrl}
            onChange={(e) => setNewRelayUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleAddRelay();
              }
            }}
          />
        </div>
        <Button
          onClick={handleAddRelay}
          disabled={!newRelayUrl.trim()}
          variant="outline"
          size="sm"
          className="h-10 shrink-0"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Relay
        </Button>
      </div>

      {!user && (
        <p className="text-xs text-muted-foreground">
          Log in to sync your relay list with Nostr
        </p>
      )}
    </div>
  );
}