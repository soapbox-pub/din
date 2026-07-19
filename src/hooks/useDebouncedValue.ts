import { useEffect, useState } from 'react';

/**
 * Returns `value` delayed by `delay` ms. Used to keep fast-changing inputs
 * (search boxes) from firing a relay REQ on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
