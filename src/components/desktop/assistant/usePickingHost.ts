import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAssistantHost, type AssistantHost } from '@/shared/assistant/host';

/** After the next two frames: once the window manager has committed and run its effects. */
const afterFrames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * The desktop's assistant host, telling whether Din's file picker is open
 * for it, for a composer in a panel or prompt that would otherwise close
 * when the picker's window takes focus (taking the composer, its text and
 * what's being attached with it). Give `host` to the composer with
 * AssistantHostContext, and while `picking` keep the panel open, hidden
 * out of the picker's way.
 */
export function usePickingHost(): { host: AssistantHost; picking: boolean } {
  const outer = useAssistantHost();
  const [count, setCount] = useState(0);
  const host = useMemo((): AssistantHost => {
    const whilePicking = async <T>(pick: () => Promise<T>): Promise<T> => {
      setCount((n) => n + 1);
      try {
        const result = await pick();
        // The picker's closing raises the window under it, which gives its
        // own field the keyboard back (Window's lastFocused); still picking
        // meanwhile, so that doesn't close the panel, and the composer
        // focuses its field after it.
        await afterFrames();
        return result;
      } finally {
        // Shown again before the composer goes on: a hidden field can't take focus.
        flushSync(() => setCount((n) => n - 1));
      }
    };
    return {
      ...outer,
      pickFiles: (options) => whilePicking(() => outer.pickFiles(options)),
      pickFolder: (options) => whilePicking(() => outer.pickFolder(options)),
    };
  }, [outer]);
  return { host, picking: count > 0 };
}
