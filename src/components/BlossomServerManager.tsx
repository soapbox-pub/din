import { useEffect, useState } from 'react';
import { Copy, HardDrive, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { blossomListTags, normalizeBlossomUrl } from '@/lib/relayLists';

/**
 * BlossomServerManager - edit the user's BUD-03 Blossom server list.
 *
 * The inverse of the kind 10063 sync in `NostrSync`: edits
 * `config.blossomServerMetadata` and publishes an updated kind 10063 event
 * when the user is logged in. Also exposes the `useAppBlossomServers`
 * toggle that controls whether Din's default servers are merged in.
 */
export function BlossomServerManager() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutate: publishEvent } = useNostrPublish();
  const { toast } = useToast();

  const [servers, setServers] = useState<string[]>(config.blossomServerMetadata.servers);
  const [newServerUrl, setNewServerUrl] = useState('');

  // Mirror external config changes (e.g. NostrSync loading the user's
  // kind 10063 on login) into the optimistic local list.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setServers(config.blossomServerMetadata.servers);
  }, [config.blossomServerMetadata.servers]);

  const handleAddServer = () => {
    const normalized = normalizeBlossomUrl(newServerUrl);
    if (!normalized) {
      toast({
        title: 'Invalid server URL',
        description: 'Please enter a valid URL (e.g., https://blossom.example.com)',
        variant: 'destructive',
      });
      return;
    }

    if (servers.some((s) => s.replace(/\/+$/, '') === normalized.replace(/\/+$/, ''))) {
      toast({
        title: 'Server already exists',
        description: 'This Blossom server is already in your list.',
        variant: 'destructive',
      });
      return;
    }

    const newServers = [...servers, normalized];
    setServers(newServers);
    setNewServerUrl('');
    saveServers(newServers);
  };

  const handleRemoveServer = (url: string) => {
    const newServers = servers.filter((s) => s !== url);
    setServers(newServers);
    saveServers(newServers);
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => toast({ title: 'URL copied' }),
      () => toast({ title: "Couldn't copy the URL", variant: 'destructive' }),
    );
  };

  const saveServers = (newServers: string[]) => {
    // Only called from event handlers, not during render.
     
    const now = Math.floor(Date.now() / 1000);

    updateConfig((current) => ({
      ...current,
      blossomServerMetadata: {
        servers: newServers,
        updatedAt: now,
      },
    }));

    if (user) {
      publishEvent(
        {
          kind: 10063,
          content: '',
          tags: blossomListTags(newServers),
        },
        {
          onSuccess: () => {
            toast({
              title: 'Blossom server list published',
              description: 'Your server list has been published to Nostr.',
            });
          },
          onError: (error) => {
            console.error('Failed to publish Blossom server list:', error);
            toast({
              title: 'Failed to publish server list',
              description: 'There was an error publishing your Blossom server list to Nostr.',
              variant: 'destructive',
            });
          },
        },
      );
    }
  };

  const renderServerUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.pathname === '/' ? parsed.host : parsed.host + parsed.pathname;
    } catch {
      return url;
    }
  };

  return (
    <div className="space-y-4">
      {/* Server list */}
      <div className="space-y-2">
        {servers.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No personal Blossom servers configured.
          </p>
        ) : (
          servers.map((url) => (
            <ContextMenu key={url}>
              <ContextMenuTrigger asChild>
                <div
                  className="flex items-center gap-3 rounded-md border bg-muted/20 p-3"
                >
                  <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm" title={url}>
                    {renderServerUrl(url)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${renderServerUrl(url)}`}
                    onClick={() => handleRemoveServer(url)}
                    className="size-5 shrink-0 text-muted-foreground hover:bg-transparent hover:text-destructive"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => copyUrl(url)}>
                  <Copy aria-hidden />
                  Copy URL
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => handleRemoveServer(url)}>
                  <X aria-hidden />
                  Remove
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))
        )}
      </div>

      {/* Add server form */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Label htmlFor="new-blossom-url" className="sr-only">
            Blossom server URL
          </Label>
          <Input
            id="new-blossom-url"
            placeholder="Enter server URL (e.g., https://blossom.example.com)"
            value={newServerUrl}
            onChange={(e) => setNewServerUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddServer();
            }}
          />
        </div>
        <Button
          onClick={handleAddServer}
          disabled={!newServerUrl.trim()}
          variant="outline"
          size="sm"
          className="h-10 shrink-0"
        >
          <Plus className="mr-2 size-4" />
          Add Server
        </Button>
      </div>

      {/* Default-server merge toggle */}
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="use-app-blossom" className="cursor-pointer text-sm">
            Include Din's default servers
          </Label>
          <p className="text-xs text-muted-foreground">
            Merge Din's built-in Blossom servers with your own list.
          </p>
        </div>
        <Switch
          id="use-app-blossom"
          checked={config.useAppBlossomServers}
          onCheckedChange={(checked) =>
            updateConfig((current) => ({ ...current, useAppBlossomServers: checked }))
          }
        />
      </div>

      {!user && (
        <p className="text-xs text-muted-foreground">
          Log in to sync your Blossom server list with Nostr
        </p>
      )}
    </div>
  );
}
