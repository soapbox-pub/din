import { useEffect, useState } from 'react';
import { Bell, Camera, MapPin, Mic, Puzzle, type LucideIcon } from 'lucide-react';
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
  getPromptHostBridge,
  type ShellPromptRequest,
  type SiteCapability,
} from '@/lib/promptBridge';

const CAPABILITIES: Record<SiteCapability, { label: string; icon: LucideIcon }> = {
  camera: { label: 'Use your camera', icon: Camera },
  microphone: { label: 'Use your microphone', icon: Mic },
  geolocation: { label: 'Know your location', icon: MapPin },
  notifications: { label: 'Show notifications', icon: Bell },
};

/** Match patterns that grant access to every site. */
const ALL_SITES = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);

/** A request origin as a readable host (`meet.example`), falling back to the raw string. */
function displayHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * Desktop-lifetime host for questions the main process asks the user (see
 * electron/main.mts's askShell): web pages requesting the camera, microphone,
 * location, or notifications, and Chrome Web Store extension installs. Shows
 * one prompt at a time; dismissing a prompt answers "no".
 *
 * Renders nothing outside the Electron shell.
 */
export function PromptHost() {
  const [queue, setQueue] = useState<ShellPromptRequest[]>([]);

  useEffect(() => {
    const bridge = getPromptHostBridge();
    if (!bridge) return;
    const offRequest = bridge.onRequest((request) => setQueue((q) => [...q, request]));
    const offCancel = bridge.onCancel((requestId) =>
      setQueue((q) => q.filter((r) => r.requestId !== requestId)),
    );
    return () => {
      offRequest();
      offCancel();
    };
  }, []);

  const current = queue[0] ?? null;

  const answer = (allow: boolean) => {
    if (!current) return;
    getPromptHostBridge()?.respond({ requestId: current.requestId, allow });
    setQueue((q) => q.filter((r) => r.requestId !== current.requestId));
  };

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
    >
      {/* Keyed so consecutive prompts don't animate as one dialog morphing. */}
      <DialogContent key={current?.requestId} className="sm:max-w-md">
        {current?.kind === 'permission' && <PermissionPrompt request={current} />}
        {current?.kind === 'extension-install' && <ExtensionInstallPrompt request={current} />}
        <DialogFooter>
          <Button variant="secondary" onClick={() => answer(false)}>
            {current?.kind === 'extension-install' ? 'Cancel' : 'Block'}
          </Button>
          <Button onClick={() => answer(true)}>
            {current?.kind === 'extension-install' ? 'Add extension' : 'Allow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionPrompt({
  request,
}: {
  request: Extract<ShellPromptRequest, { kind: 'permission' }>;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-all">{displayHost(request.origin)} wants to</DialogTitle>
        <DialogDescription>
          Your answer applies to this site until Din restarts.
        </DialogDescription>
      </DialogHeader>
      <ul className="space-y-2">
        {request.capabilities.map((capability) => {
          const { label, icon: Icon } = CAPABILITIES[capability];
          return (
            <li key={capability} className="flex items-center gap-3 text-sm">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
                <Icon className="size-4 text-muted-foreground" aria-hidden />
              </span>
              {label}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ExtensionInstallPrompt({
  request,
}: {
  request: Extract<ShellPromptRequest, { kind: 'extension-install' }>;
}) {
  const allSites = request.hostPermissions.some((p) => ALL_SITES.has(p));
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Puzzle className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-words">Add “{request.name}”?</span>
        </DialogTitle>
        <DialogDescription>
          Extensions run inside the Web Browser with the access listed below.
          Only add extensions you trust.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        {allSites ? (
          <p className="font-medium">Read and change all your data on all websites</p>
        ) : request.hostPermissions.length > 0 ? (
          <div>
            <p className="font-medium">Read and change your data on:</p>
            <ul className="mt-1 max-h-32 overflow-y-auto text-muted-foreground">
              {request.hostPermissions.map((site) => (
                <li key={site} className="break-all">{site}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {request.permissions.length > 0 && (
          <p className="text-muted-foreground">
            Also uses: {request.permissions.join(', ')}
          </p>
        )}
      </div>
    </>
  );
}
