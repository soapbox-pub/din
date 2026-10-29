// Where a pty's output goes, when it isn't where it was spawned: a terminal
// tab moved to another window of its app hands its pty over
// (electron/din-apps.mts). main.mts's pty handlers send through this.

export type PtySend = (channel: string, ...args: unknown[]) => void;

export const ptyRoutes = new Map<number, PtySend>();
