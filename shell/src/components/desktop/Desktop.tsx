import { Wallpaper } from './Wallpaper';
import { Taskbar } from './Taskbar';

/** The desktop session: wallpaper workspace with a bottom taskbar. */
export function Desktop() {
  return (
    <Wallpaper>
      {/* Workspace area - windows will render here */}
      <main aria-label="Desktop" className="relative flex-1" />

      <Taskbar />
    </Wallpaper>
  );
}
