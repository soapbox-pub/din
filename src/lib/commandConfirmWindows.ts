/**
 * The window a `din` command's question opens in (ctx.confirm, answered in
 * src/components/desktop/apps/CommandConfirmWindow.tsx): hidden from the
 * launcher, one per question, opened by CommandHost with a `request` launch
 * param naming one of the questions below. A window rather than a dialog, so
 * it can be moved aside, looked past and screenshotted around while the rest
 * of the desktop goes on working. Never restored: what asked before a
 * restart isn't waiting.
 */
export const COMMAND_CONFIRM_APP_ID = 'command-confirm';

export interface CommandQuestion {
  title: string;
  description: string;
  /** The button that says yes. */
  action: string;
  destructive?: boolean;
  /** What asked: the command, as typed (`din mail unsubscribe`). */
  command: string;
  /** Asked from an Assistant conversation. */
  fromAssistant: boolean;
}

interface Waiting extends CommandQuestion {
  resolve: (ok: boolean) => void;
}

const waiting = new Map<number, Waiting>();
let next = 1;

/** Keep a question until it's answered; returns its id for the window. */
export function addCommandQuestion(question: CommandQuestion, resolve: (ok: boolean) => void): number {
  const id = next++;
  waiting.set(id, { ...question, resolve });
  return id;
}

export function getCommandQuestion(id: number): CommandQuestion | undefined {
  return waiting.get(id);
}

/** Answer it, once; later answers (the window closing after a click) are ignored. */
export function answerCommandQuestion(id: number, ok: boolean): void {
  const q = waiting.get(id);
  if (!q) return;
  waiting.delete(id);
  q.resolve(ok);
}
