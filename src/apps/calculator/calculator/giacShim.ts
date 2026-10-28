// Giac's Emscripten glue was built for a page: it reads `window`, and reports
// parse errors through alert(). In the worker `self` stands in for the
// window, and alerts are collected as the error of the running command.
// Imported before the glue so this runs first.

const scope = self as unknown as Record<string, unknown>;

/** Messages giac alerted or printed while the current command ran. */
export const giacMessages: string[] = [];

scope.window = self;
scope.alert = (message: unknown) => {
  giacMessages.push(String(message));
};
scope.prompt = () => null;
