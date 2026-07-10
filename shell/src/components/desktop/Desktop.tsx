import { Wallpaper } from './Wallpaper';
import { Taskbar } from './Taskbar';
import { Window } from './Window';
import { useWindows } from '@/hooks/useWindows';
import { WindowManagerContext } from '@/contexts/WindowManagerContext';

/** The desktop session: wallpaper workspace with a bottom taskbar. */
export function Desktop() {
  const manager = useWindows();
  const topZ = manager.windows.reduce((max, w) => Math.max(max, w.z), 0);

  return (
    <WindowManagerContext.Provider value={manager}>
      <Wallpaper>
        {/* Workspace area - windows render here */}
        <main aria-label="Desktop" className="relative flex-1 overflow-hidden">
          {manager.windows.map((win) => (
            <Window key={win.id} window={win} isTop={win.z === topZ} />
          ))}
        </main>

        <Taskbar />
      </Wallpaper>
    </WindowManagerContext.Provider>
  );
}
