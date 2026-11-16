import { format } from 'node:util';

/**
 * The extension APIs' logging (chrome-extensions*.mts, chrome-api-*.mts):
 * silent unless DEBUG names them, as the `debug` package upstream used did
 * (`DEBUG=din:crx*`, or `DEBUG=*`). `%r` prints a value as JSON with long
 * strings (data: icons) cut short.
 */

const enabled = (namespace: string): boolean => {
  const spec = process.env.DEBUG ?? '';
  return spec.split(/[\s,]+/).some((pattern) => {
    if (!pattern) return false;
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(namespace);
  });
};

const short = (_key: string, value: unknown) =>
  typeof value === 'string' && value.length > 128 ? `${value.slice(0, 128)}...` : value;

export function debug(name: string): (message: string, ...args: unknown[]) => void {
  const namespace = `din:crx:${name.replace(/^electron-chrome-extensions:/, '')}`;
  if (!enabled(namespace)) return () => {};
  return (message, ...args) => {
    const text = message.replace(/%r/g, '%s');
    const shown = message.includes('%r')
      ? args.map((arg) => (typeof arg === 'object' && arg !== null ? JSON.stringify(arg, short, 2) : arg))
      : args;
    console.debug(`${namespace} ${format(text, ...shown)}`);
  };
}
