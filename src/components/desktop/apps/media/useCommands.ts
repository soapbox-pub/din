import { useCallback, useMemo, useState } from 'react';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getFsBridge } from '@/lib/fs';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { installSkin, OPEN_EXTENSIONS, openPaths, SKIN_EXTENSIONS } from './actions';
import { makeTrack, player } from './engine';
import { library } from './library';
import { askText } from './din/askText';
import { useSavePlaylist } from './din/useSavePlaylist';

/** File and window commands shared by every skin's menus and buttons. */
export function useCommands(windowId: string) {
  const { pickFiles } = useFilePicker();
  const { close, minimize } = useWindowActions();
  const savePlaylistAs = useSavePlaylist();
  const [message, setMessage] = useState<string | null>(null);

  const openFiles = useCallback(
    async (how: 'play' | 'enqueue' = 'play') => {
      const home = await getFsBridge()?.homedir();
      const result = await pickFiles({
        title: how === 'play' ? 'Open' : 'Add to Now Playing',
        multiple: true,
        initialPath: home ? `${home}/Music` : undefined,
        filters: [
          { name: 'Media and playlists', patterns: OPEN_EXTENSIONS.map((e) => `*${e}`), mimeTypes: [] },
          { name: 'Skins', patterns: SKIN_EXTENSIONS.map((e) => `*${e}`), mimeTypes: [] },
        ],
      });
      if (!result) return;
      setMessage(await openPaths(result.paths, how));
    },
    [pickFiles],
  );

  const openFolder = useCallback(
    async (how: 'play' | 'enqueue' = 'enqueue') => {
      const result = await pickFiles({ title: 'Add Folder', directory: true, confirmLabel: 'Add' });
      if (!result) return;
      setMessage(await openPaths(result.paths, how));
    },
    [pickFiles],
  );

  const openUrl = useCallback(async () => {
    const url = await askText('Open URL', 'Type the address of a stream or a song on the web.', 'https://', 'Open');
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setMessage('Only http and https addresses can be opened.');
      return;
    }
    player.setQueue([makeTrack(url)], 0, true);
  }, []);

  const savePlaylist = useCallback(async () => {
    try {
      await savePlaylistAs(player.getState().queue);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [savePlaylistAs]);

  const loadSkin = useCallback(async () => {
    const result = await pickFiles({ title: 'Choose a Skin', extensions: SKIN_EXTENSIONS });
    if (!result) return;
    try {
      await installSkin(result.paths[0]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [pickFiles]);

  const addLibraryFolder = useCallback(async () => {
    const result = await pickFiles({ title: 'Add Folder to Library', directory: true, confirmLabel: 'Add' });
    if (result?.paths[0]) library.addFolder(result.paths[0]);
  }, [pickFiles]);

  return useMemo(
    () => ({
      openFiles,
      openFolder,
      openUrl,
      savePlaylist,
      loadSkin,
      addLibraryFolder,
      close: () => close(windowId),
      minimize: () => minimize(windowId),
      message,
      clearMessage: () => setMessage(null),
      setMessage,
    }),
    [openFiles, openFolder, openUrl, savePlaylist, loadSkin, addLibraryFolder, close, minimize, windowId, message],
  );
}

export type Commands = ReturnType<typeof useCommands>;
