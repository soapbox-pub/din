import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  CircleAlert,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderSearch,
  Globe,
  MoreHorizontal,
  Package,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { subscribeAssistantEvents, useAssistantStatus, useHomeDirectory } from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import { cleanAssistantError, getAssistantBridge, tildify, type SkillChange, type SkillInfo, type SkillSettings, type SkillSource } from '@/lib/assistant';
import { isRemovableSource, removeSourceWording, skillLocation, skillSourceBadge, skillSourceDetail, skillSourceName, SKILLS_QUERY_KEY } from '@/lib/assistantSkills';
import { cn } from '@/lib/utils';
import { StatusPill } from '@/shared/appChrome';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsToken } from '@/shared/settingsChrome';

/** One thing a row's ⋯ menu and its right-click menu both offer. */
type Action = { key: string; label: string; icon: LucideIcon; run: () => void; disabled?: boolean; destructive?: boolean } | 'separator';

const SOURCE_ICONS: Record<SkillSource['kind'], LucideIcon> = {
  folder: Folder,
  default: Folder,
  other: FolderSearch,
  catalog: Globe,
  din: Package,
  opencode: Package,
};

function sourceKey(source: SkillSource): string {
  return `${source.kind}:${source.entry ?? source.path ?? ''}`;
}

/** How things would stand with these skills on or off, to show while the change is made. */
function withEnabled(settings: SkillSettings, ids: string[], enabled: boolean): SkillSettings {
  return {
    ...settings,
    sources: settings.sources.map((source) => ({
      ...source,
      skills: source.skills.map((skill) => (ids.includes(skill.id) ? { ...skill, enabled } : skill)),
    })),
  };
}

/**
 * The assistant's skills: the folders OpenCode finds them in, each opening
 * to its skills, with a switch for every one. Folders can be added and
 * taken away; what Din and OpenCode come with, and the folders OpenCode
 * looks in anyway, are listed after them. All of it is OpenCode's own
 * config (electron/assistant-skills.mts), so it's the same in a Terminal.
 */
export function SkillsSettings() {
  const { data: status } = useAssistantStatus();
  const ready = Boolean(status?.running);
  const bridge = getAssistantBridge();
  const home = useHomeDirectory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { pickFile } = useFilePicker();
  const { open } = useWindowActions();
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  /** The folder whose removal is being asked about. */
  const [removing, setRemoving] = useState<SkillSource | null>(null);
  const switchIds = useId();

  const { data: settings, error, isFetching, refetch } = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: () => bridge!.skills(),
    enabled: ready && bridge !== undefined,
    staleTime: 10_000,
  });

  useEffect(
    () =>
      subscribeAssistantEvents((event) => {
        if (event.type === 'din.skills' || event.type === 'skill.updated' || event.type === 'config.updated' || event.type === 'din.connected') {
          void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
        }
      }),
    [queryClient],
  );

  const change = useMutation({
    mutationFn: (c: SkillChange) => bridge!.changeSkills(c),
    onMutate: (c) => {
      if (c.op !== 'setEnabled') return;
      queryClient.setQueryData<SkillSettings>(SKILLS_QUERY_KEY, (current) => current && withEnabled(current, c.ids, c.enabled));
    },
    onSuccess: (next) => queryClient.setQueryData(SKILLS_QUERY_KEY, next),
    onError: (e, c) => {
      toast({
        title: c.op === 'addFolder' ? 'Couldn’t add the folder' : c.op === 'removeFolder' ? 'Couldn’t remove it' : 'Couldn’t change the skill',
        description: cleanAssistantError(e),
        variant: 'destructive',
      });
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    },
  });

  const locked = Boolean(settings?.error);
  const busy = change.isPending;

  const addFolder = async () => {
    const picked = await pickFile({ title: 'Add a folder of skills', confirmLabel: 'Add', directory: true, initialPath: home }).catch(() => null);
    if (!picked) return;
    change.mutate(
      { op: 'addFolder', path: picked },
      { onSuccess: () => setOpened((current) => new Set(current).add(`folder:${tildify(picked, home)}`)) },
    );
  };
  const setEnabled = (ids: string[], enabled: boolean) => change.mutate({ op: 'setEnabled', ids, enabled });
  const showInFiles = (folder: string, select?: string) => open('file-browser', select ? { path: folder, select } : { path: folder });
  const toggle = (key: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const sourceActions = (source: SkillSource): Action[] => {
    const actions: Action[] = [];
    if (source.path && !source.missing) {
      actions.push({ key: 'show', label: 'Show in Files', icon: FolderOpen, run: () => showInFiles(source.path!) });
    }
    if (source.skills.length > 0) {
      if (actions.length > 0) actions.push('separator');
      const ids = source.skills.map((skill) => skill.id);
      actions.push(
        { key: 'on', label: 'Turn All On', icon: Power, disabled: locked || busy || source.skills.every((s) => s.enabled), run: () => setEnabled(ids, true) },
        { key: 'off', label: 'Turn All Off', icon: PowerOff, disabled: locked || busy || source.skills.every((s) => !s.enabled), run: () => setEnabled(ids, false) },
      );
    }
    if (isRemovableSource(source)) {
      if (actions.length > 0) actions.push('separator');
      actions.push({
        key: 'remove',
        label: removeSourceWording(source).menu,
        icon: FolderMinus,
        disabled: locked || busy,
        destructive: true,
        // Asks first, from either menu.
        run: () => setRemoving(source),
      });
    }
    return actions;
  };

  const skillActions = (skill: SkillInfo): Action[] => {
    const location = skillLocation(skill);
    return [
      ...(location ? [{ key: 'show', label: 'Show in Files', icon: FolderOpen, run: () => showInFiles(location.folder, location.name) }, 'separator' as const] : []),
      {
        key: 'toggle',
        label: skill.enabled ? 'Turn Off' : 'Turn On',
        icon: skill.enabled ? PowerOff : Power,
        disabled: locked || busy,
        run: () => setEnabled([skill.id], !skill.enabled),
      },
    ];
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="px-1 text-sm font-semibold text-foreground/90">Skills</h3>
          <p className="px-1 text-xs text-muted-foreground">
            Instructions the assistant picks up when a task calls for them, kept in folders. One that’s off is hidden from it.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={!settings || locked || busy} onClick={() => void addFolder()}>
          <Plus className="size-4.5" strokeWidth={1.75} aria-hidden /> Add folder
        </Button>
      </div>

      {settings?.error && (
        <p role="alert" className="flex items-start gap-2 px-1 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-words">{settings.error}. Skills can be changed once it’s mended.</span>
        </p>
      )}

      {settings && error && !settings.error && (
        // The list below is what was last read; say the refresh failed.
        <div role="alert" className="flex items-center gap-2 px-1 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">Couldn’t refresh the skills: {cleanAssistantError(error)}</span>
          <Button variant="ghost" size="xs" className="shrink-0 text-foreground" disabled={isFetching} onClick={() => void refetch()}>
            <RotateCw className={cn(isFetching && 'motion-safe:animate-spin')} aria-hidden /> Try again
          </Button>
        </div>
      )}

      {status && !ready ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">OpenCode needs to be running to manage skills.</p>
      ) : !settings ? (
        error ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">Couldn’t list the skills: {cleanAssistantError(error)}</p>
        ) : (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        )
      ) : settings.sources.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-muted-foreground">No skills yet. Add a folder that has some.</p>
      ) : (
        settings.sources.map((source, sourceIndex) => {
          const key = sourceKey(source);
          const isOpen = opened.has(key);
          const name = skillSourceName(source, home);
          const badge = skillSourceBadge(source);
          const actions = sourceActions(source);
          return (
            <ul key={key} className={settingsGroup} aria-label={name}>
              <ContextMenu>
                <ContextMenuTrigger asChild disabled={actions.length === 0}>
                  <li className="flex items-center pr-2">
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 pl-3 text-left outline-none',
                        'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
                        source.skills.length > 0 ? 'hover:bg-foreground/5' : 'cursor-default',
                      )}
                      aria-expanded={source.skills.length > 0 ? isOpen : undefined}
                      disabled={source.skills.length === 0}
                      onClick={() => toggle(key)}
                    >
                      <ChevronRight
                        className={cn(
                          'size-4.5 shrink-0 text-muted-foreground motion-safe:transition-transform',
                          isOpen && 'rotate-90',
                          source.skills.length === 0 && 'invisible',
                        )}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <SettingsToken icon={SOURCE_ICONS[source.kind]} />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium" title={source.path ?? source.entry ?? undefined}>
                            {name}
                          </span>
                          {badge && <StatusPill title={badge.title}>{badge.label}</StatusPill>}
                        </span>
                        <span className={cn('block truncate text-xs', source.missing ? 'text-warning' : 'text-muted-foreground')}>
                          {skillSourceDetail(source)}
                        </span>
                      </span>
                    </button>
                    {actions.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`More for ${name}`}>
                            <MoreHorizontal className="size-4.5" strokeWidth={1.75} aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          {actions.map((a, i) =>
                            a === 'separator' ? (
                              <DropdownMenuSeparator key={`separator-${i}`} />
                            ) : (
                              <DropdownMenuItem key={a.key} disabled={a.disabled} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.run}>
                                <a.icon />
                                {a.label}
                              </DropdownMenuItem>
                            ),
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <MenuItems actions={actions} />
                </ContextMenuContent>
              </ContextMenu>
              {isOpen &&
                source.skills.map((skill, skillIndex) => {
                  // Unique even where two sources list the same id.
                  const switchId = `${switchIds}-${sourceIndex}-${skillIndex}`;
                  return (
                    <ContextMenu key={skill.id}>
                      <ContextMenuTrigger asChild>
                        <li className="flex items-center gap-3 py-2.5 pr-4 pl-3" data-skill={skill.id}>
                          {/* As wide as the folder's chevron and icon, so the name lines up with the folder's. */}
                          <span aria-hidden className="size-4.5 shrink-0" />
                          <span aria-hidden className="size-8 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <label htmlFor={switchId} className="block cursor-pointer truncate text-sm" title={skill.name !== skill.id ? skill.id : undefined}>
                              {skill.name}
                            </label>
                            {skill.description && (
                              <p className="line-clamp-2 text-xs text-muted-foreground" title={skill.description}>
                                {skill.description}
                              </p>
                            )}
                          </div>
                          <Switch
                            id={switchId}
                            className="ml-1 shrink-0"
                            checked={skill.enabled}
                            disabled={locked || busy}
                            onCheckedChange={(enabled) => setEnabled([skill.id], enabled)}
                          />
                        </li>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <MenuItems actions={skillActions(skill)} />
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
            </ul>
          );
        })
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          {removing && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{removeSourceWording(removing).title}</AlertDialogTitle>
                <AlertDialogDescription>{removeSourceWording(removing, home).description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => change.mutate({ op: 'removeFolder', entry: removing.entry! })}>
                  {removeSourceWording(removing).action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MenuItems({ actions }: { actions: Action[] }) {
  return actions.map((a, i) =>
    a === 'separator' ? (
      <ContextMenuSeparator key={`separator-${i}`} />
    ) : (
      <ContextMenuItem key={a.key} disabled={a.disabled} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.run}>
        <a.icon aria-hidden />
        {a.label}
      </ContextMenuItem>
    ),
  );
}
