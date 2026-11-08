import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Copy, ExternalLink, FileCode2, FolderOpen, GitBranch, Globe, PanelRightClose, RotateCw, X } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useDin, WindowControls, WindowDragRegion } from '@/sdk/react';
import { ToolButton } from '@/shared/appChrome';
import { flushPane, focusRing, toolIcon } from '@/shared/appChromeStyles';
import { useAssistantHost } from '@/shared/assistant/host';
import { useHomeDirectory } from '@/hooks/useAssistant';
import { tildify } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { GitPanel } from './GitPanel';
import type { Preview } from '@/shared/assistant/previews';

/*
 * The pane at the Assistant's right: Git, and a tab for each page the agent
 * showed with its preview tool (previews.ts). A server on this computer is
 * framed as it is; a file through a URL whose token serves its folder alone
 * (din.files.pageUrl), sandboxed in an origin of its own. Neither gets the
 * app's permissions or its origin (main checks the frames: `preview` in
 * electron/din-apps.mts).
 */

/** The pane's tabs: Git's, or a preview's by its URI. */
export type SideTab = 'git' | string;

/** The sandbox a server's page runs in: its own origin (http://localhost:…), so its modules and HMR work. */
const SERVER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';
/** A file's page: an opaque origin, as the CSP it's served with has it too. */
const FILE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

export function SidePanel({
  directory,
  previews,
  tab,
  onTab,
  onClosePreview,
  reloads,
  onReload,
  onHide,
  className,
  style,
}: {
  /** The folder the conversation works in, whose repository the Git tab shows. */
  directory: string | undefined;
  previews: Preview[];
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  onClosePreview: (uri: string) => void;
  /** How many times each preview has been reloaded, by URI: its frame starts again when it changes. */
  reloads: Record<string, number>;
  onReload: (uri: string) => void;
  onHide: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const shown = previews.find((p) => p.uri === tab);
  return (
    <aside aria-label="Git and previews" style={style} className={cn('flex min-h-0 shrink-0 flex-col text-foreground', className)}>
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1 pl-3 pr-3">
        <ToolButton label="Hide the side pane (Ctrl+Shift+G for Git)" onClick={onHide}>
          <PanelRightClose {...toolIcon} aria-hidden />
        </ToolButton>
        <div role="tablist" aria-label="Side pane" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <SideTabButton selected={!shown} onSelect={() => onTab('git')} icon={<GitBranch {...toolIcon} aria-hidden />} label="Git" />
          {previews.map((preview) => (
            <PreviewMenu key={preview.uri} preview={preview} onReload={() => onReload(preview.uri)} onClose={() => onClosePreview(preview.uri)}>
              <SideTabButton
                selected={preview === shown}
                onSelect={() => onTab(preview.uri)}
                icon={<PreviewIcon preview={preview} />}
                label={preview.title}
                title={preview.uri}
                onClose={() => onClosePreview(preview.uri)}
              />
            </PreviewMenu>
          ))}
        </div>
        <WindowControls />
      </WindowDragRegion>
      {shown ? (
        <PreviewView key={shown.uri} preview={shown} reload={reloads[shown.uri] ?? 0} onReload={() => onReload(shown.uri)} />
      ) : (
        <GitPanel key={directory} directory={directory} />
      )}
    </aside>
  );
}

function PreviewIcon({ preview }: { preview: Preview }) {
  return preview.target.kind === 'server' ? <Globe {...toolIcon} aria-hidden /> : <FileCode2 {...toolIcon} aria-hidden />;
}

/** A tab in the pane's title bar: a capsule, tinted while chosen, a preview's with its close button. */
function SideTabButton({
  selected,
  onSelect,
  icon,
  label,
  title,
  onClose,
  ref,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onSelect' | 'title'> & {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  title?: string;
  onClose?: () => void;
}) {
  return (
    <div
      ref={ref}
      {...props}
      className={cn(
        'group flex h-8 min-w-0 shrink-0 items-center rounded-full text-sm',
        selected ? 'bg-selected text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        onClose ? 'max-w-48 pr-1' : '',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={title ?? label}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1 && onClose) onClose();
        }}
        className={cn('flex h-8 min-w-0 items-center gap-1.5 rounded-full pl-3 [&_svg]:shrink-0', onClose ? 'pr-1' : 'pr-3', focusRing)}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={onClose}
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-full hover:bg-foreground/[0.07]',
            selected ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            focusRing,
          )}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** What a preview offers, in its tab's right-click menu and its toolbar alike. */
function usePreviewActions(preview: Preview) {
  const { openUrl, showInFolder, notify } = useAssistantHost();
  const { target } = preview;
  return {
    open: target.kind === 'server' ? () => openUrl(target.url) : () => showInFolder(target.path),
    openLabel: target.kind === 'server' ? 'Open in Browser' : 'Show in Files',
    copy: () =>
      void navigator.clipboard.writeText(target.kind === 'server' ? target.url : target.path).then(
        () => notify({ title: target.kind === 'server' ? 'Address copied' : 'Path copied' }),
        () => notify({ title: 'Couldn’t copy', destructive: true }),
      ),
    copyLabel: target.kind === 'server' ? 'Copy Address' : 'Copy Path',
  };
}

function PreviewMenu({ preview, onReload, onClose, children }: { preview: Preview; onReload: () => void; onClose: () => void; children: ReactNode }) {
  const actions = usePreviewActions(preview);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onReload}>
          <RotateCw aria-hidden /> Reload
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.open}>
          {preview.target.kind === 'server' ? <ExternalLink aria-hidden /> : <FolderOpen aria-hidden />} {actions.openLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.copy}>
          <Copy aria-hidden /> {actions.copyLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}>
          <X aria-hidden /> Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** URLs of files' pages, by path: one each for as long as the window's page is loaded. */
const pageUrls = new Map<string, Promise<string>>();

/** The URL a file's page is framed from (din.files.pageUrl), or why it can't be. */
function usePageUrl(path: string | null): { url?: string; error?: string } {
  const din = useDin();
  const [state, setState] = useState<{ path: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let pending = pageUrls.get(path);
    if (!pending) {
      pending = din.files.fromPath(path).then((handle) => {
        if (handle.kind !== 'file') throw new Error(`${path} is a folder`);
        return din.files.pageUrl(handle as FileSystemFileHandle);
      });
      pageUrls.set(path, pending);
      // Tried again the next time it's shown.
      pending.catch(() => pageUrls.delete(path));
    }
    pending.then(
      (url) => live && setState({ path, url }),
      (error: unknown) => live && setState({ path, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [din, path]);
  return state?.path === path ? state : {};
}

/** A preview: its toolbar (reload, where it is, opening it elsewhere) over the page. */
function PreviewView({ preview, reload, onReload }: { preview: Preview; reload: number; onReload: () => void }) {
  const home = useHomeDirectory();
  const actions = usePreviewActions(preview);
  const { target } = preview;
  const file = usePageUrl(target.kind === 'file' ? target.path : null);
  const src = target.kind === 'server' ? target.url : file.url;
  const address = target.kind === 'server' ? target.url : tildify(target.path, home);

  return (
    <div role="tabpanel" aria-label={preview.title} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <ToolButton label="Reload" onClick={onReload}>
          <RotateCw {...toolIcon} aria-hidden />
        </ToolButton>
        <input
          readOnly
          value={address}
          aria-label={target.kind === 'server' ? 'Address' : 'File'}
          title={target.kind === 'server' ? target.url : target.path}
          onFocus={(e) => e.currentTarget.select()}
          className={cn('h-8 min-w-0 flex-1 truncate rounded-full bg-foreground/[0.06] px-3 text-sm text-muted-foreground', focusRing)}
        />
        <ToolButton label={actions.openLabel} onClick={actions.open}>
          {target.kind === 'server' ? <ExternalLink {...toolIcon} aria-hidden /> : <FolderOpen {...toolIcon} aria-hidden />}
        </ToolButton>
      </div>
      <div className={cn('mr-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white clay', flushPane)}>
        {src ? (
          <iframe
            key={`${src}#${reload}`}
            src={src}
            title={preview.title}
            sandbox={target.kind === 'server' ? SERVER_SANDBOX : FILE_SANDBOX}
            referrerPolicy="no-referrer"
            className="size-full flex-1 border-0 bg-white"
          />
        ) : file.error ? (
          <div className="grid flex-1 place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
            <p className="max-w-sm">
              <span className="block font-medium text-foreground">Couldn’t show this page</span>
              <span className="mt-1 block">{file.error}</span>
            </p>
          </div>
        ) : (
          <div className="flex-1 space-y-3 bg-background p-6" aria-label="Loading the page">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        )}
      </div>
    </div>
  );
}
