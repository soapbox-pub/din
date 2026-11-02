import { createContext, useContext } from 'react';
import type { DesktopEntry, DesktopIconSort, IconGrid, PlacedIcon } from '@/lib/desktopIcons';
import type { FsEntry } from '@/lib/fs';
import type { WorkArea } from '@/lib/monitors';

/** A file or folder in ~/Desktop. */
export interface DesktopIcon extends FsEntry {
  path: string;
  /** What it's called on the desktop: a launcher's Name, else its file name. */
  label: string;
  /** A launcher's entry, for .desktop files. */
  entry?: DesktopEntry;
}

export interface DesktopIconsContextValue {
  /** Whether icons show (the setting), and there's a filesystem to show. */
  shown: boolean;
  /** The desktop folder, once known; null without a filesystem. */
  dir: string | null;
  /** What's in it, hidden files and launchers left out. */
  icons: DesktopIcon[];
  /** Where each icon is, by name. */
  places: ReadonlyMap<string, PlacedIcon>;
  /** A work area's icon grid. */
  grid(area: WorkArea): IconGrid;
  /** Whether a cell is taken by an icon (but `except`) or a widget. */
  taken(area: WorkArea, col: number, row: number, except?: ReadonlySet<string>): boolean;
  selected: ReadonlySet<string>;
  setSelected(names: ReadonlySet<string>): void;
  /** The icon whose label is being edited. */
  renaming: string | null;
  setRenaming(name: string | null): void;

  /** Open icons, as double-clicking them does. */
  open(names: readonly string[]): Promise<void>;
  /** Open files in a given app. */
  openWith(appId: string, names: readonly string[]): void;
  /** Show icons in Files (their folder, or the desktop folder with none). */
  showInFiles(names?: readonly string[]): void;
  /** Put icons on cells; those taken push the moved one to the nearest free cell. */
  place(moves: readonly { name: string; monitor: string; col: number; row: number }[]): void;
  /** Lay every icon out again from the top-left corner, sorted, or with none in the order they're in (Clean Up). */
  arrange(by?: DesktopIconSort): void;
  newFolder(): Promise<string>;
  newTextFile(): Promise<string>;
  rename(name: string, to: string): Promise<void>;
  trash(names: readonly string[]): Promise<void>;
  /** Make a shortcut to an app; resolves to its file's name. */
  addApp(appId: string, at?: { monitor: string; col: number; row: number }): Promise<string>;
  /** Copy (or move) files and folders onto the desktop; resolves to their new names. */
  addPaths(paths: readonly string[], options?: { move?: boolean; at?: { monitor: string; col: number; row: number } }): Promise<string[]>;
  /** Read the folder again. */
  reload(): Promise<void>;
}

export const DesktopIconsContext = createContext<DesktopIconsContextValue | undefined>(undefined);

/** The desktop's icons. Must be used within the Desktop. */
export function useDesktopIcons(): DesktopIconsContextValue {
  const ctx = useContext(DesktopIconsContext);
  if (!ctx) throw new Error('useDesktopIcons must be used within a Desktop');
  return ctx;
}
