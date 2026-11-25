import { createElement, type CSSProperties, type ReactNode } from 'react';
import {
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  GitBranch,
  PanelRightClose,
  RotateCw,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { WindowControls, WindowDragRegion } from '@/sdk/react';
import { SegmentedControl, ToolButton } from '@/shared/appChrome';
import { flushPane, focusRing, searchRow, toolIcon } from '@/shared/appChromeStyles';
import { useAssistantHost } from '@/shared/assistant/host';
import { cn } from '@/lib/utils';
import { GitPanel } from './GitPanel';
import { FilePreview, type FileMode } from './FilePreview';
import { fileView, hasSource, previewIcon, type Preview } from '@/shared/assistant/previews';

/*
 * The pane at the Assistant's right: Git, and a tab for each page or file
 * the agent showed with its preview tool (previews.ts). A server on this
 * computer is framed as it is, in its own origin; a file is shown by kind
 * (FilePreview.tsx), a web page among them through a URL whose token serves
 * its folder alone (din.files.pageUrl), sandboxed in an origin of its own.
 * Neither page gets the app's permissions or its origin (main checks the
 * frames: `preview` in electron/din-apps.mts).
 */

/** The pane's tabs: Git's, or a preview's by its URI. */
export type SideTab = 'git' | string;

/** The sandbox a server's page runs in: its own origin (http://localhost:…), so its modules and HMR work. */
const SERVER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

/** Whether a preview is a file that can show its source. */
function sourceable(preview: Preview): boolean {
  return preview.target.kind === 'file' && hasSource(fileView(preview.target.path));
}

export function SidePanel({
  directory,
  previews,
  tab,
  onTab,
  onClosePreview,
  reloads,
  onReload,
  modes,
  onMode,
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
  /** Which files are shown as their source rather than drawn, by URI. */
  modes: Record<string, FileMode>;
  onMode: (uri: string, mode: FileMode) => void;
  onHide: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const shown = previews.find((p) => p.uri === tab);
  const modeOf = (preview: Preview): FileMode => modes[preview.uri] ?? 'rendered';
  return (
    <aside aria-label="Git and previews" style={style} className={cn('flex min-h-0 shrink-0 flex-col text-foreground', className)}>
      {/* The title bar holds only the pane's toggle and the window's controls, so the controls read as the window's, not the pane's. */}
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1 pl-3 pr-3">
        <ToolButton label="Hide the side pane (Ctrl+Shift+G for Git)" onClick={onHide}>
          <PanelRightClose {...toolIcon} aria-hidden />
        </ToolButton>
        <div className="flex-1" />
        <WindowControls />
      </WindowDragRegion>
      {/* The tabs, in the band under the title bar, level with the list's search. */}
      <div className={searchRow}>
        <div role="tablist" aria-label="Side pane" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <SideTabButton
            selected={!shown}
            onSelect={() => onTab('git')}
            icon={<GitBranch {...toolIcon} aria-hidden />}
            label="Git"
            // Alone, Git's tab closes the pane, as a last preview's would.
            onClose={previews.length === 0 ? onHide : undefined}
          />
          {previews.map((preview) => (
            <PreviewMenu
              key={preview.uri}
              preview={preview}
              mode={modeOf(preview)}
              onMode={(mode) => {
                onMode(preview.uri, mode);
                onTab(preview.uri);
              }}
              onReload={() => onReload(preview.uri)}
              onClose={() => onClosePreview(preview.uri)}
            >
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
        {/* A page, Markdown or SVG drawn, or its source: at the band's end, over what it switches. */}
        {shown && sourceable(shown) && (
          <SegmentedControl
            label="Show the file"
            size="md"
            className="ml-2"
            value={modeOf(shown)}
            onValueChange={(mode) => onMode(shown.uri, mode)}
            options={[
              { value: 'rendered', label: 'Preview' },
              { value: 'source', label: 'Source' },
            ]}
          />
        )}
      </div>
      {shown ? (
        <PreviewView key={shown.uri} preview={shown} mode={modeOf(shown)} reload={reloads[shown.uri] ?? 0} />
      ) : (
        <GitPanel key={directory} directory={directory} />
      )}
    </aside>
  );
}

function PreviewIcon({ preview }: { preview: Preview }) {
  return createElement(previewIcon(preview.target), { ...toolIcon, 'aria-hidden': true });
}

/** A tab in the band under the pane's title bar: a capsule, tinted while chosen, a preview's with its close button. */
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

/** What a preview offers, in its tab's right-click menu. */
function usePreviewActions(preview: Preview) {
  const { openUrl, openPath, showInFolder, notify } = useAssistantHost();
  const { target } = preview;
  return {
    open: target.kind === 'server' ? () => openUrl(target.url) : () => showInFolder(target.path),
    openLabel: target.kind === 'server' ? 'Open in Browser' : 'Show in Files',
    /** A file, in the app Files would open it in. */
    openFile: target.kind === 'file' ? () => openPath(target.path, 'file') : undefined,
    copy: () =>
      void navigator.clipboard.writeText(target.kind === 'server' ? target.url : target.path).then(
        () => notify({ title: target.kind === 'server' ? 'Address copied' : 'Path copied' }),
        () => notify({ title: 'Couldn’t copy', destructive: true }),
      ),
    copyLabel: target.kind === 'server' ? 'Copy Address' : 'Copy Path',
  };
}

function PreviewMenu({
  preview,
  mode,
  onMode,
  onReload,
  onClose,
  children,
}: {
  preview: Preview;
  mode: FileMode;
  onMode: (mode: FileMode) => void;
  onReload: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const actions = usePreviewActions(preview);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onReload}>
          <RotateCw aria-hidden /> Reload
        </ContextMenuItem>
        {sourceable(preview) &&
          (mode === 'source' ? (
            <ContextMenuItem onSelect={() => onMode('rendered')}>
              <Eye aria-hidden /> Show Preview
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => onMode('source')}>
              <Code2 aria-hidden /> Show Source
            </ContextMenuItem>
          ))}
        <ContextMenuSeparator />
        {actions.openFile && (
          <ContextMenuItem onSelect={actions.openFile}>
            <SquareArrowOutUpRight aria-hidden /> Open
          </ContextMenuItem>
        )}
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

/** A preview, right under the pane's tabs (its tab's right-click menu reloads it, opens it elsewhere or copies where it is). */
function PreviewView({ preview, mode, reload }: { preview: Preview; mode: FileMode; reload: number }) {
  const { target } = preview;
  return (
    <div role="tabpanel" aria-label={preview.title} className="flex min-h-0 flex-1 flex-col">
      <div className={cn('mr-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl clay', flushPane, target.kind === 'server' && 'bg-white')}>
        {target.kind === 'server' ? (
          <iframe
            key={`${target.url}#${reload}`}
            src={target.url}
            title={preview.title}
            sandbox={SERVER_SANDBOX}
            referrerPolicy="no-referrer"
            className="size-full flex-1 border-0 bg-white"
          />
        ) : (
          <FilePreview path={target.path} title={preview.title} mode={mode} reload={reload} />
        )}
      </div>
    </div>
  );
}
