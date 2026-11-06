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
import { ToolButton } from '@/shared/appChrome';
import { SettingsToken } from '@/shared/settingsChrome';
import { settingsCard, settingsGroup } from '@/shared/settingsChromeStyles';
import type { AppComponentProps } from '@/lib/apps';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useUserscripts } from '@/hooks/useUserscripts';
import { useToast } from '@/hooks/useToast';
import { SettingsSubHeading } from '@/shared/settingsSection';

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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <SettingsSubHeading className="mt-0 px-0">Userscripts</SettingsSubHeading>
          <p className="text-xs text-muted-foreground">
            Scripts that run automatically on matching sites.
          </p>
        </div>
        <ToolButton label="Add Userscript" onClick={onAdd}>
          <Plus className="size-4.5" strokeWidth={1.75} />
        </ToolButton>
      </div>

      {scripts.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No userscripts yet. Open a .user.js link to install one, or add your
          own.
        </p>
      ) : (
        <ul className={settingsGroup}>
          {scripts.map((script) => (
            <ContextMenu key={script.id}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 py-2 pr-2 pl-4">
                  <SettingsToken icon={FileCode2} active={script.enabled} />
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
                  <ToolButton size="sm" label={`Remove ${script.name}`} onClick={() => onRemove(script)} className="hover:bg-destructive/10 hover:text-destructive">
                    <Trash2 className="size-4" strokeWidth={1.75} />
                  </ToolButton>
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

/**
 * Installing a userscript, in a window of its own beside the browser
 * (src/lib/webPopup.ts): its parsed name, version and targets above its
 * editable source, refusing anything without a valid ==UserScript== block.
 * Launch params `code` and `url`; `at` starts it over.
 */
export function UserscriptInstallWindow({ windowId, params }: AppComponentProps) {
  useWindowTitle('Install Userscript');
  const code = typeof params?.code === 'string' ? params.code : '';
  const url = typeof params?.url === 'string' ? params.url : undefined;
  return <UserscriptInstall key={String(params?.at)} windowId={windowId} initial={code} url={url} />;
}

function UserscriptInstall({ windowId, initial, url }: { windowId: string; initial: string; url?: string }) {
  const { close } = useWindowActions();
  const { install } = useUserscripts();
  const { toast } = useToast();
  const [code, setCode] = useState(initial);
  const meta = useMemo(() => (code.trim() ? parseUserscriptMeta(code) : null), [code]);

  const submit = () => {
    try {
      const script = install(code, url);
      toast({ title: `${script.name} installed`, description: 'It runs on matching pages from their next load.' });
      close(windowId);
    } catch (error) {
      toast({
        title: "Couldn't install userscript",
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-background p-4 [&>*]:shrink-0">
      <p className="px-1 text-sm text-muted-foreground">
        Userscripts run automatically on the sites they match, with the same access to those pages as the sites
        themselves. Only install scripts you trust.
      </p>
      {meta ? (
        <div className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')}>
          <SettingsToken icon={FileCode2} active />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {meta.name}
              {meta.version && <span className="text-muted-foreground"> v{meta.version}</span>}
            </p>
            {meta.description && <p className="line-clamp-2 text-xs text-muted-foreground">{meta.description}</p>}
            <p className="truncate text-xs text-muted-foreground">Runs on: {describeTargets(meta.matches, meta.includes)}</p>
          </div>
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          Paste a script with a <code>==UserScript==</code> metadata header below.
        </p>
      )}
      <Textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label="Userscript source"
        spellCheck={false}
        autoComplete="off"
        placeholder={'// ==UserScript==\n// @name   My script\n// @match  https://example.com/*\n// ==/UserScript==\n'}
        className="min-h-56 flex-1 resize-none font-mono text-xs"
      />
      {url && (
        <p className="truncate px-1 text-xs text-muted-foreground" title={url}>
          From {url}
        </p>
      )}
      <div className="mt-auto flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(windowId)}>
          Cancel
        </Button>
        <Button disabled={!meta} onClick={submit}>
          Install
        </Button>
      </div>
    </div>
  );
}
