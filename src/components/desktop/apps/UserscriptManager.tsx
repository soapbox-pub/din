import { useMemo, useState } from 'react';
import { FileCode2, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseUserscriptMeta, type Userscript } from '@/lib/userscripts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Human summary of where a script runs, from its match/include rules. */
function describeTargets(matches: string[], includes: string[]): string {
  const rules = [...matches, ...includes];
  if (rules.length === 0) return 'all sites';
  const shown = rules.slice(0, 2).join(', ');
  return rules.length > 2 ? `${shown} +${rules.length - 2} more` : shown;
}

/**
 * The userscripts block of the browser's extensions menu: installed scripts
 * with enable toggles and remove buttons, plus an add-your-own entry point.
 */
export function UserscriptsSection({
  scripts,
  onSetEnabled,
  onRemove,
  onAdd,
}: {
  scripts: Userscript[];
  onSetEnabled: (id: string, enabled: boolean) => void;
  onRemove: (script: Userscript) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">Userscripts</h3>
          <p className="text-xs text-muted-foreground">
            Scripts that run automatically on matching sites.
          </p>
        </div>
        <button
          type="button"
          aria-label="Add userscript"
          title="Add userscript"
          onClick={onAdd}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-md text-foreground/60',
            'hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <Plus className="size-4" />
        </button>
      </div>

      {scripts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No userscripts yet. Open a .user.js link to install one, or add your
          own.
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {scripts.map((script) => (
            <ContextMenu key={script.id}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-2 rounded-md px-1 py-1">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary">
                    <FileCode2 className="size-3.5 text-muted-foreground" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'truncate text-sm',
                        !script.enabled && 'text-muted-foreground',
                      )}
                    >
                      {script.name}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={describeTargets(script.matches, script.includes)}
                    >
                      {script.version ? `v${script.version} · ` : ''}
                      {describeTargets(script.matches, script.includes)}
                    </p>
                  </div>
                  <Switch
                    aria-label={`Enable ${script.name}`}
                    checked={script.enabled}
                    onCheckedChange={(enabled) => onSetEnabled(script.id, enabled)}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${script.name}`}
                    title={`Remove ${script.name}`}
                    onClick={() => onRemove(script)}
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-md text-foreground/60',
                      'hover:bg-destructive/10 hover:text-destructive',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => onSetEnabled(script.id, !script.enabled)}>
                  {script.enabled ? 'Disable' : 'Enable'}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => onRemove(script)}>
                  <Trash2 />
                  Remove
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the install dialog opens with: source text plus its origin, if any. */
export interface UserscriptInstallRequest {
  /** Prefilled source (empty string for a manual paste). */
  code: string;
  /** The *.user.js URL the script came from, when installed via navigation. */
  url?: string;
}

/**
 * The install/review dialog: shows the parsed metadata (name, version,
 * targets) above an editable source view, and refuses to install anything
 * without a valid ==UserScript== block.
 */
export function UserscriptInstallDialog({
  request,
  onOpenChange,
  onInstall,
}: {
  request: UserscriptInstallRequest | null;
  onOpenChange: (open: boolean) => void;
  onInstall: (code: string, downloadUrl?: string) => void;
}) {
  const [code, setCode] = useState('');

  // Reset the editor whenever a new request opens the dialog (state adjusted
  // during render, per react.dev's "you might not need an effect").
  const [lastRequest, setLastRequest] = useState<UserscriptInstallRequest | null>(null);
  if (request !== lastRequest) {
    setLastRequest(request);
    if (request) setCode(request.code);
  }

  const meta = useMemo(
    () => (code.trim() ? parseUserscriptMeta(code) : null),
    [code],
  );

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install userscript</DialogTitle>
          <DialogDescription>
            Userscripts run automatically on the sites they match, with the
            same access to those pages as the sites themselves. Only install
            scripts you trust.
          </DialogDescription>
        </DialogHeader>

        {meta ? (
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
              <FileCode2 className="size-4 text-muted-foreground" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {meta.name}
                {meta.version && (
                  <span className="text-muted-foreground"> v{meta.version}</span>
                )}
              </p>
              {meta.description && (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {meta.description}
                </p>
              )}
              <p className="truncate text-xs text-muted-foreground">
                Runs on: {describeTargets(meta.matches, meta.includes)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Paste a script with a <code>==UserScript==</code> metadata header
            below.
          </p>
        )}

        <Textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Userscript source"
          spellCheck={false}
          autoComplete="off"
          placeholder={
            '// ==UserScript==\n// @name   My script\n// @match  https://example.com/*\n// ==/UserScript==\n'
          }
          className="h-56 resize-none font-mono text-xs"
        />

        {request?.url && (
          <p className="truncate text-xs text-muted-foreground" title={request.url}>
            From {request.url}
          </p>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!meta} onClick={() => onInstall(code, request?.url)}>
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
