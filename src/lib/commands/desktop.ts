import { activeWorkspace, isShown, WORKSPACE_COUNT, type WindowState } from '@/hooks/useWindows';
import { getBrowserBridge, siteOriginOf } from '@/lib/browser';
import { SNAP_ZONES, type SnapZone } from '@/lib/monitors';
import { getFsBridge } from '@/lib/fs';
import { openPath } from '@/lib/openPath';
import { DESKTOP_ICON_SORTS, type DesktopIconSort } from '@/lib/desktopIcons';
import {
  activateNotification, clearNotifications, closeNotification, getNotificationState, notify,
} from '@/lib/notificationCenter';
import { getScreenshotBridge, saveScreenshot, dataUrlToBytes } from '@/lib/screenshot';
import {
  getScreenRecorderBridge, startRecording, stopRecording, type RecordingAudio, type RecordingRequest,
} from '@/lib/screenRecorder';
import { builtinWidget, builtinWidgets, widgetTitle, WIDGET_SIZES, type WidgetSize } from '@/lib/widgets';
import { websiteLabel } from '@/lib/nsiteApps';
import { resetWindowsApps, WINDOWS_RESET_CONSEQUENCE } from '@/lib/nativeApps';
import { reopenSkippedSession } from '@/lib/windowSession';
import { resolvePath } from './parse';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { bare, call, command, need, pick } from './util';

/**
 * `din apps`, `din windows`, `din workspace`, `din widgets`, `din desktop-icons`,
 * `din notifications`, `din screenshot`, `din browser`, `din open`: what the
 * Dock, the apps menu, window chrome, the menu bar and the Web Browser do.
 */

function appRow(ctx: CommandContext, id: string) {
  const app = ctx.apps.getApp(id);
  return app?.name ?? id;
}

function windowRow(ctx: CommandContext, w: WindowState) {
  return {
    id: w.id,
    app: w.appId,
    title: w.title ?? appRow(ctx, w.appId),
    workspace: w.workspace,
    state: w.minimized ? 'minimized' : w.maximized ? 'maximized' : w.snapped ? `tiled ${w.snapped}` : w.away ? 'other workspace' : 'shown',
    focused: false,
    x: Math.round(w.x), y: Math.round(w.y), width: Math.round(w.width), height: Math.round(w.height),
  };
}

function live(ctx: CommandContext): WindowState[] {
  return ctx.windows.filter((w) => !w.closing);
}

/** A window by its id, or by its app's id or name or its title when only one matches. */
function findWindow(ctx: CommandContext, query: string): WindowState {
  return pick(live(ctx), query, (w) => [w.id, w.appId, w.title, ctx.apps.getApp(w.appId)?.name], 'window');
}

const WINDOW: Param = { name: 'window', type: 'string', positional: true, help: 'Its id (din windows list), or its app or title' };

export const appsArea: Area = {
  name: 'apps',
  summary: 'Apps: list, open, install, remove, and run your own (din apps run)',
  commands: [
    command('apps', 'list', 'Every app on the desktop', [
      { name: 'installed', type: 'boolean', optional: true, help: 'Only those you installed (web apps, nsites, folders)' },
    ], (args, ctx) => {
      const apps = ctx.apps.apps
        .filter((app) => !args.optBool('installed') || ctx.apps.canUninstall(app.id))
        .map((app) => ({ id: app.id, name: app.name, kind: app.native ? 'linux' : ctx.apps.canUninstall(app.id) ? 'installed' : 'built-in' }));
      return { data: apps };
    }),
    command('apps', 'open', 'Open an app, with files if you like', [
      { name: 'app', type: 'string', positional: true, help: 'Its id or name' },
      { name: 'files', type: 'path', positional: true, rest: true, help: 'Files to open in it' },
    ], (args, ctx) => {
      const app = pick(ctx.apps.apps, args.string('app'), (a) => [a.id, a.name], 'app');
      const files = args.list('files');
      const id = ctx.actions.open(app.id, files.length === 1 ? { path: files[0] } : files.length > 1 ? { paths: files } : undefined);
      return { data: { window: id ?? null }, text: id ? `Opened ${app.name} (${id})` : `Started ${app.name}` };
    }),
    command('apps', 'install', 'Install a website as an app', [
      { name: 'url', type: 'string', positional: true, help: 'Its https URL' },
      { name: 'name', type: 'string', optional: true, help: 'What to call it (default: its host)' },
    ], (args, ctx) => {
      const url = args.string('url');
      let name = args.optString('name');
      try {
        name ??= new URL(url).hostname;
      } catch {
        throw new CommandError(`Not a URL: ${url}`, 'usage');
      }
      const app = ctx.apps.installWebApp({ name, url });
      if (!app) throw new CommandError(`Can’t install ${url}: it needs to be https`);
      return { data: app, text: `Installed ${app.name} (${app.id})` };
    }),
    command('apps', 'install-nsite', 'Install an nsite as an app', [
      { name: 'host', type: 'string', positional: true, help: 'Its canonical host' },
      { name: 'name', type: 'string', optional: true, help: 'What to call it' },
    ], (args, ctx) => {
      const app = ctx.apps.installNsiteApp(args.string('host'), args.optString('name'));
      if (!app) throw new CommandError('That isn’t an nsite’s canonical host, or nsites can’t run here');
      return { data: app };
    }),
    command('apps', 'remove', 'Uninstall an app you installed', [
      { name: 'app', type: 'string', positional: true, help: 'Its id or name' },
    ], (args, ctx) => {
      const app = pick(ctx.apps.apps, args.string('app'), (a) => [a.id, a.name], 'app');
      if (!ctx.apps.canUninstall(app.id)) throw new CommandError(`${app.name} can’t be removed`);
      ctx.apps.uninstallApp(app.id);
      return { text: `Removed ${app.name}` };
    }),
    command('apps', 'reset-windows', 'Start Windows apps over: delete every Windows program installed, and its settings', [], async (_args, ctx) => {
      const ok = await ctx.confirm({
        title: 'Reset Windows apps?',
        description: `A command asked to reset them. ${WINDOWS_RESET_CONSEQUENCE}`,
        action: 'Reset',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await resetWindowsApps();
      return { text: 'Windows apps start over: the next Windows program sets them up anew' };
    }),
    command('apps', 'links', 'Websites whose links an installed nsite opens, because the website names it as its own', [], (_args, ctx) => ({
      data: ctx.apps.linkedWebsites.map((website) => ({
        website: websiteLabel(website),
        app: website.appId,
        name: appRow(ctx, website.appId),
        on: website.on,
      })),
    })),
    command('apps', 'open-links', 'Let an nsite open the links of websites that name it, or stop it', [
      { name: 'app', type: 'string', positional: true, help: 'Its id or name' },
      { name: 'on', type: 'boolean', positional: true, help: 'on or off' },
    ], (args, ctx) => {
      const app = pick(ctx.apps.apps, args.string('app'), (a) => [a.id, a.name], 'app');
      const websites = ctx.apps.linkedWebsites.filter((website) => website.appId === app.id);
      if (websites.length === 0) throw new CommandError(`No website names ${app.name} as its own`);
      const on = args.bool('on');
      ctx.apps.setOpensLinks(app.id, on);
      const list = websites.map(websiteLabel).join(', ');
      return { text: on ? `${list} links open in ${app.name}` : `${list} links open in the Web Browser` };
    }),
    {
      path: ['apps', 'run'],
      summary: 'Run a web app from a folder or a dev server in a window, its console here',
      client: true,
      params: [
        { name: 'folder', type: 'path', positional: true, optional: true, help: 'A folder with an index.html (or a project whose dist/ has one)' },
        { name: 'files', type: 'path', positional: true, rest: true, help: 'Files to open in it' },
        { name: 'url', type: 'string', optional: true, help: 'A dev server to run it from instead' },
        { name: 'origin', type: 'string', optional: true, help: 'Run at din://NAME/ and keep its storage' },
        { name: 'detach', type: 'boolean', optional: true, help: 'Return once its window is open' },
        { name: 'quiet', type: 'boolean', optional: true, help: 'Don’t print its console' },
      ],
      run: () => {
        throw new CommandError('din apps run runs in the din command');
      },
    },
  ],
};

export const windowsArea: Area = {
  name: 'windows',
  summary: 'Windows: list, focus, move, resize, maximize, close',
  commands: [
    command('windows', 'list', 'Open windows, front to back', [], (_args, ctx) => {
      const windows = [...live(ctx)].sort((a, b) => b.z - a.z);
      const front = windows.find(isShown);
      return { data: windows.map((w) => ({ ...windowRow(ctx, w), focused: w === front })) };
    }),
    command('windows', 'focus', 'Bring a window to the front', [WINDOW], (args, ctx) => {
      ctx.actions.focus(findWindow(ctx, args.string('window')).id);
    }),
    command('windows', 'close', 'Close a window', [WINDOW], (args, ctx) => {
      ctx.actions.close(findWindow(ctx, args.string('window')).id);
    }),
    command('windows', 'minimize', 'Minimize a window', [WINDOW], (args, ctx) => {
      ctx.actions.minimize(findWindow(ctx, args.string('window')).id);
    }),
    command('windows', 'maximize', 'Maximize a window, or restore it', [WINDOW], (args, ctx) => {
      ctx.actions.toggleMaximize(findWindow(ctx, args.string('window')).id);
    }),
    command('windows', 'tile', 'Snap a window to half or a quarter of the screen', [
      WINDOW,
      { name: 'zone', type: 'string', positional: true, choices: [...SNAP_ZONES], help: 'Which half or quarter' },
    ], (args, ctx) => {
      ctx.actions.tile(findWindow(ctx, args.string('window')).id, args.string('zone') as SnapZone);
    }),
    command('windows', 'move', 'Move a window', [
      WINDOW,
      { name: 'x', type: 'integer', positional: true, help: 'Its left edge' },
      { name: 'y', type: 'integer', positional: true, help: 'Its top edge' },
    ], (args, ctx) => {
      ctx.actions.move(findWindow(ctx, args.string('window')).id, args.number('x'), args.number('y'));
    }),
    command('windows', 'resize', 'Resize a window', [
      WINDOW,
      { name: 'width', type: 'integer', positional: true, min: 1, help: 'Its width' },
      { name: 'height', type: 'integer', positional: true, min: 1, help: 'Its height' },
    ], (args, ctx) => {
      const w = findWindow(ctx, args.string('window'));
      ctx.actions.resize(w.id, { x: w.x, y: w.y, width: args.number('width'), height: args.number('height') });
    }),
    command('windows', 'workspace', 'Send a window to another workspace', [
      WINDOW,
      { name: 'n', type: 'integer', positional: true, min: 1, max: WORKSPACE_COUNT, help: 'The workspace' },
      { name: 'follow', type: 'boolean', optional: true, help: 'Go there with it' },
    ], (args, ctx) => {
      ctx.actions.moveToWorkspace(findWindow(ctx, args.string('window')).id, args.number('n'), args.optBool('follow') ?? false);
    }),
    command('windows', 'reopen', 'Reopen the windows from before Din started, when it left them closed after a failed start', [], () => {
      if (!reopenSkippedSession()) throw new CommandError('There are no windows to reopen');
    }),
  ],
};

export const workspaceArea: Area = {
  name: 'workspace',
  summary: 'Workspaces: which one each monitor shows',
  commands: [
    command('workspace', 'status', 'The workspace each monitor shows', [], (_args, ctx) => ({
      data: ctx.monitors.map((monitor) => ({ monitor, workspace: activeWorkspace(ctx.workspaces, monitor) })),
    })),
    command('workspace', 'switch', 'Show a workspace', [
      { name: 'n', type: 'integer', positional: true, min: 1, max: WORKSPACE_COUNT, help: 'The workspace' },
    ], (args, ctx) => {
      ctx.actions.showWorkspace(args.number('n'));
    }),
  ],
};

const SIZES = Object.keys(WIDGET_SIZES) as WidgetSize[];

export const widgetsArea: Area = {
  name: 'widgets',
  summary: 'Desktop widgets: list, add, remove, resize, and add your own (din widgets add-folder)',
  commands: [
    command('widgets', 'list', 'The widgets on the desktop', [], (_args, ctx) => ({
      data: ctx.widgets.widgets.map((w) => ({
        id: w.id, widget: widgetTitle(w.source), kind: w.source.type, size: `${w.cols}x${w.rows}`, monitor: w.monitor,
        ...(w.source.type === 'file' ? { folder: w.source.path } : {}),
      })),
    })),
    command('widgets', 'available', 'Din’s own widgets, to add', [], () => ({
      data: [...builtinWidgets().entries()].map(([id, manifest]) => ({ id, name: manifest.name, about: manifest.description })),
    })),
    command('widgets', 'add', 'Put one of Din’s widgets on the desktop', [
      { name: 'widget', type: 'string', positional: true, help: 'Its id, from din widgets available' },
      { name: 'size', type: 'string', optional: true, choices: SIZES, help: 'Its size' },
    ], (args, ctx) => {
      const id = args.string('widget');
      if (!builtinWidget(id)) throw new CommandError(`No widget ${id}; din widgets available lists them`);
      ctx.widgets.add({ type: 'builtin', id }, args.has('size') ? { size: args.string('size') as WidgetSize } : undefined);
    }),
    command('widgets', 'remove', 'Take a widget off the desktop', [
      { name: 'widget', type: 'string', positional: true, help: 'Its id, from din widgets list' },
    ], (args, ctx) => {
      const widget = pick(ctx.widgets.widgets, args.string('widget'), (w) => [w.id, widgetTitle(w.source)], 'widget');
      ctx.widgets.remove(widget.id);
    }),
    command('widgets', 'resize', 'Make a widget another size', [
      { name: 'widget', type: 'string', positional: true, help: 'Its id, from din widgets list' },
      { name: 'size', type: 'string', positional: true, choices: SIZES, help: 'Its new size' },
    ], (args, ctx) => {
      const widget = pick(ctx.widgets.widgets, args.string('widget'), (w) => [w.id, widgetTitle(w.source)], 'widget');
      ctx.widgets.resize(widget.id, args.string('size') as WidgetSize);
    }),
    {
      path: ['widgets', 'add-folder'],
      summary: 'Put a folder’s widget on the desktop, once you allow what it asks for; it reloads as the folder changes',
      client: true,
      params: [
        { name: 'folder', type: 'path', positional: true, help: 'A folder with a napplet’s index.html' },
        { name: 'size', type: 'string', optional: true, choices: SIZES, help: 'The size it starts at' },
      ],
      run: () => {
        throw new CommandError('din widgets add-folder runs in the din command');
      },
    },
  ],
};

const ICON: Param = { name: 'icon', type: 'string', positional: true, help: 'Its file name, or what it’s called on the desktop' };

function findIcon(ctx: CommandContext, query: string) {
  return pick(ctx.desktopIcons.icons, query, (i) => [i.name, i.label], 'desktop icon');
}

function needIcons(ctx: CommandContext): string {
  if (!ctx.desktopIcons.dir) throw new CommandError('Desktop icons need the filesystem, which isn’t here');
  return ctx.desktopIcons.dir;
}

export const desktopIconsArea: Area = {
  name: 'desktop-icons',
  summary: 'Desktop icons: what’s in ~/Desktop, shortcuts to apps, arranging them (showing them and their size are din settings desktop.*)',
  commands: [
    command('desktop-icons', 'list', 'The icons on the desktop, and where they are', [], (_args, ctx) => {
      needIcons(ctx);
      return {
        data: ctx.desktopIcons.icons.map((i) => {
          const place = ctx.desktopIcons.places.get(i.name);
          return {
            name: i.name, label: i.label, kind: i.entry ? 'shortcut' : i.kind,
            ...(i.entry?.app ? { app: i.entry.app } : {}),
            monitor: place?.area.id ?? '', col: place?.col ?? null, row: place?.row ?? null,
          };
        }),
      };
    }),
    command('desktop-icons', 'open', 'Open an icon, as double-clicking it does', [ICON], async (args, ctx) => {
      needIcons(ctx);
      await call(ctx.desktopIcons.open([findIcon(ctx, args.string('icon')).name]));
    }),
    command('desktop-icons', 'add-app', 'Put a shortcut to an app on the desktop', [
      { name: 'app', type: 'string', positional: true, help: 'Its id or name' },
    ], async (args, ctx) => {
      needIcons(ctx);
      const app = pick(ctx.apps.apps, args.string('app'), (a) => [a.id, a.name], 'app');
      const name = await call(ctx.desktopIcons.addApp(app.id));
      return { data: { name }, text: `Added ${app.name} to the desktop (${name})` };
    }),
    command('desktop-icons', 'add', 'Copy files or folders onto the desktop', [
      { name: 'paths', type: 'path', positional: true, rest: true, help: 'What to put there' },
      { name: 'move', type: 'boolean', optional: true, help: 'Move them there instead of copying' },
    ], async (args, ctx) => {
      needIcons(ctx);
      const paths = args.list('paths');
      if (paths.length === 0) throw new CommandError('Name something to add', 'usage');
      const names = await call(ctx.desktopIcons.addPaths(paths, { move: args.optBool('move') ?? false }));
      return { data: { names } };
    }),
    command('desktop-icons', 'new-folder', 'Make a folder on the desktop', [
      { name: 'name', type: 'string', positional: true, optional: true, help: 'What to call it (default: New Folder)' },
    ], async (args, ctx) => {
      needIcons(ctx);
      const made = await call(ctx.desktopIcons.newFolder());
      ctx.desktopIcons.setRenaming(null);
      const name = args.optString('name');
      if (name && name !== made) await call(ctx.desktopIcons.rename(made, name));
      return { data: { name: name ?? made }, text: name ?? made };
    }),
    command('desktop-icons', 'rename', 'Rename an icon’s file', [
      ICON,
      { name: 'name', type: 'string', positional: true, help: 'Its new name' },
    ], async (args, ctx) => {
      needIcons(ctx);
      await call(ctx.desktopIcons.rename(findIcon(ctx, args.string('icon')).name, args.string('name')));
    }),
    command('desktop-icons', 'remove', 'Move an icon’s file to the Trash', [ICON], async (args, ctx) => {
      needIcons(ctx);
      const icon = findIcon(ctx, args.string('icon'));
      await call(ctx.desktopIcons.trash([icon.name]));
      return { text: `Moved ${icon.name} to the Trash` };
    }),
    command('desktop-icons', 'arrange', 'Lay the icons out again from the top-left corner', [
      { name: 'by', type: 'string', optional: true, choices: DESKTOP_ICON_SORTS.map((s) => s.value), help: 'Sorted by this (default: as they are, closing the gaps)' },
    ], (args, ctx) => {
      needIcons(ctx);
      ctx.desktopIcons.arrange(args.optString('by') as DesktopIconSort | undefined);
    }),
  ],
};

export const notificationsArea: Area = {
  name: 'notifications',
  summary: 'Notifications: list, send, dismiss (Do Not Disturb is under din settings)',
  commands: [
    command('notifications', 'list', 'Notifications in the list, newest first', [], () => ({
      data: getNotificationState().notifications.map((n) => ({
        id: n.id, from: n.source.name, title: n.title, body: n.body, read: n.read,
        actions: n.onScreenOnly ? '' : n.actions.map((a) => a.id).join(' '),
      })),
    })),
    command('notifications', 'send', 'Show a notification', [
      { name: 'title', type: 'string', positional: true, help: 'Its title' },
      { name: 'body', type: 'string', positional: true, optional: true, help: 'Its text' },
      { name: 'urgency', type: 'string', optional: true, choices: ['low', 'normal', 'critical'], help: 'Critical ones pop up through Do Not Disturb' },
    ], (args) => {
      const id = notify({
        source: { name: 'din' },
        title: args.string('title'),
        body: args.optString('body') ?? '',
        urgency: (args.optString('urgency') ?? 'normal') as 'low' | 'normal' | 'critical',
      });
      return { data: { id }, text: id };
    }),
    command('notifications', 'activate', 'Click a notification, or one of its buttons', [
      { name: 'id', type: 'string', positional: true, help: 'Its id' },
      { name: 'action', type: 'string', optional: true, help: 'The button’s id (default: the notification itself)' },
    ], (args) => {
      const id = args.string('id');
      if (getNotificationState().notifications.find((n) => n.id === id)?.onScreenOnly) {
        throw new CommandError('Only you can answer this one, on screen');
      }
      activateNotification(id, args.optString('action') ?? 'default');
    }),
    command('notifications', 'dismiss', 'Dismiss a notification', [
      { name: 'id', type: 'string', positional: true, help: 'Its id' },
    ], (args) => {
      closeNotification(args.string('id'));
    }),
    command('notifications', 'clear', 'Dismiss them all', [], () => {
      clearNotifications();
    }),
  ],
};

export const screenshotArea: Area = {
  name: 'screenshot',
  summary: 'Take a screenshot of the desktop, or record it',
  commands: [
    bare(command('screenshot', 'take', 'Save the desktop as a PNG (default: in ~/Pictures/Screenshots)', [
      { name: 'file', type: 'path', positional: true, optional: true, help: 'Where to save it' },
    ], async (args) => {
      const shot = await call(need(getScreenshotBridge(), 'Screenshots').capture());
      const fs = need(getFsBridge(), 'Saving files');
      const file = args.optString('file');
      if (file) await call(fs.writeFile(file, dataUrlToBytes(shot.dataUrl)));
      const path = file ?? await call(saveScreenshot(fs, shot));
      return { data: { path, width: shot.width, height: shot.height }, text: path };
    })),
    command('screenshot', 'record', 'Start recording the screen to an MP4 (default: in ~/Videos/Screen Recordings); `din screenshot stop` ends it', [
      { name: 'file', type: 'path', positional: true, optional: true, help: 'Where to save it' },
      { name: 'sound', type: 'string', optional: true, choices: ['none', 'system', 'microphone'], help: 'The computer’s sound or the microphone (default: none)' },
      { name: 'area', type: 'string', optional: true, help: 'Just this part of the screen, as X,Y,WIDTHxHEIGHT (default: the main display)' },
    ], async (args) => {
      const area = args.optString('area');
      let region: RecordingRequest['region'];
      if (area !== undefined) {
        const m = area.match(/^\s*(\d+)\s*,\s*(\d+)\s*[, ]\s*(\d+)\s*x\s*(\d+)\s*$/i);
        if (!m) throw new CommandError('Give the area as X,Y,WIDTHxHEIGHT, e.g. 0,0,1280x720', 'usage');
        region = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
      }
      need(getScreenRecorderBridge(), 'Screen recording');
      const status = await call(startRecording({
        path: args.optString('file'),
        audio: args.optString('sound') as RecordingAudio | undefined,
        region,
      }));
      const path = status.recording?.path ?? '';
      return { data: { path }, text: `Recording to ${path}` };
    }),
    command('screenshot', 'stop', 'Stop recording the screen and save the video', [], async () => {
      need(getScreenRecorderBridge(), 'Screen recording');
      const finished = await call(stopRecording());
      if (!finished) throw new CommandError('The screen isn’t being recorded');
      if (!finished.path) throw new CommandError(finished.error ?? 'Nothing was recorded');
      return { data: { path: finished.path, seconds: Math.round(finished.durationMs / 1000) }, text: finished.path };
    }),
  ],
};

export const browserArea: Area = {
  name: 'browser',
  summary: 'The Web Browser’s site data',
  commands: [
    command('browser', 'clear-site-data', 'Delete a site’s cookies and storage, as its site info’s Delete site data (asks on screen first)', [
      { name: 'site', type: 'string', positional: true, help: 'The site’s URL, e.g. https://example.com' },
    ], async (args, ctx) => {
      const site = args.string('site');
      const origin = siteOriginOf(site);
      if (!origin) throw new CommandError(`Not a website’s URL: ${site}`, 'usage');
      const browser = need(getBrowserBridge(), 'The Web Browser');
      const name = origin.slice(origin.indexOf('//') + 2);
      const ok = await ctx.confirm({
        title: `Delete ${name}’s data?`,
        description: `A command asked to delete ${name}’s cookies and everything it saved on this computer, signing you out of it.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(browser.clearSiteData(origin, false));
      return { text: `Deleted ${name}’s data` };
    }),
  ],
};

export const openArea: Area = {
  name: 'open',
  summary: 'Open a file, folder or link in the app that opens it',
  commands: [
    bare(command('open', 'open', 'Open files, folders, URLs, nostr: links and mailto: links', [
      { name: 'targets', type: 'string', positional: true, rest: true, help: 'What to open' },
    ], async (args, ctx) => {
      const targets = args.list('targets');
      if (targets.length === 0) throw new CommandError('Name something to open', 'usage');
      for (const target of targets) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          ctx.openUrl(target);
          continue;
        }
        const fs = need(getFsBridge(), 'Files');
        const path = resolvePath(target, ctx.cwd);
        const stat = await call(fs.stat(path));
        await call(openPath(path, stat.kind, { open: ctx.actions.open, openUrl: ctx.openUrl, getApp: ctx.apps.getApp }));
      }
    })),
  ],
};
