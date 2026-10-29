import { useCallback, useMemo, useState } from 'react';
import { useDin } from '@/sdk/react';
import { installSkin, OPEN_EXTENSIONS, openHandles, SKIN_EXTENSIONS } from './actions';
import { makeTrack, player } from './engine';
import { library } from './library';
import { askText } from './din/askText';
import { pickFiles, pickPaths } from './host';
import { useSavePlaylist } from './din/useSavePlaylist';

/** File and window commands shared by every skin's menus and buttons. */
export function useCommands() {
  const din = useDin();
  const savePlaylistAs = useSavePlaylist();
  const [message, setMessage] = useState<string | null>(null);

  const openFiles = useCallback(
    async (how: 'play' | 'enqueue' = 'play') => {
      const files = await pickFiles({
        title: how === 'play' ? 'Open' : 'Add to Now Playing',
        multiple: true,
        startIn: 'music',
        types: [
          { description: 'Media and playlists', extensions: OPEN_EXTENSIONS },
          { description: 'Skins', extensions: SKIN_EXTENSIONS },
        ],
      });
      if (files.length === 0) return;
      setMessage(await openHandles(files, how));
    },
    [],
  );

  const openFolder = useCallback(
    async (how: 'play' | 'enqueue' = 'enqueue') => {
      const files = await pickFiles({ title: 'Add Folder', directory: true });
      if (files.length === 0) return;
      setMessage(await openHandles(files, how));
    },
    [],
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
    const [path] = await pickPaths({ title: 'Choose a Skin', types: [{ description: 'Skins', extensions: SKIN_EXTENSIONS }] });
    if (!path) return;
    try {
      await installSkin(path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const addLibraryFolder = useCallback(async () => {
    const [path] = await pickPaths({ title: 'Add Folder to Library', directory: true });
    if (path) library.addFolder(path);
  }, []);

  return useMemo(
    () => ({
      openFiles,
      openFolder,
      openUrl,
      savePlaylist,
      loadSkin,
      addLibraryFolder,
      close: () => din.window.requestClose(),
      minimize: () => din.window.minimize(),
      message,
      clearMessage: () => setMessage(null),
      setMessage,
    }),
    [din, openFiles, openFolder, openUrl, savePlaylist, loadSkin, addLibraryFolder, message],
  );
}

export type Commands = ReturnType<typeof useCommands>;
