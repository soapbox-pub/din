/**
 * Setting up Claude for the assistant (lib/claudeProvider.ts), as one run
 * per document that outlives the dialog that starts it: Settings closes its
 * dialog while the user signs in in the browser, which it would cover, and
 * shows the run in its provider list instead.
 */

import { useSyncExternalStore } from 'react';
import { cleanAssistantError, getAssistantBridge, type ClaudeLogin } from '@/lib/assistant';
import { connectClaudeProvider } from '@/lib/claudeProvider';

export type ClaudeSetupState =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'installing' }
  | { step: 'signing-in'; login: ClaudeLogin }
  | { step: 'connecting'; restarting: boolean; account: string | null }
  | { step: 'failed'; message: string };

interface Hooks {
  openUrl(url: string): void;
  /** It's done: Claude is connected, signed in as `account` when known. */
  onConnected(account: string | null): void;
}

let state: ClaudeSetupState = { step: 'idle' };
let run = 0;
const listeners = new Set<() => void>();

function set(next: ClaudeSetupState): void {
  state = next;
  for (const listener of listeners) listener();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Install Claude Code if it isn't, sign it in to the user's Claude plan in
 * the browser if it isn't, and connect OpenCode to it. A run under way is
 * left to go on.
 */
export function startClaudeSetup(hooks: Hooks): void {
  if (state.step !== 'idle' && state.step !== 'failed') return;
  const mine = ++run;
  const live = () => run === mine;
  const bridge = getAssistantBridge();
  set({ step: 'checking' });
  void (async () => {
    try {
      if (!bridge) throw new Error('Claude needs Din’s desktop app');
      let status = await bridge.claude();
      if (!status.binary) {
        if (live()) set({ step: 'installing' });
        await bridge.claudeInstall();
        status = await bridge.claude();
      }
      if (!live()) return;
      if (!status.loggedIn) {
        let login = await bridge.claudeLogin();
        if (!live()) return;
        set({ step: 'signing-in', login });
        const page = login.url ?? login.codeUrl;
        if (page) hooks.openUrl(page);
        for (;;) {
          await sleep(1_500);
          if (!live()) return;
          status = await bridge.claude();
          login = status.login ?? login;
          if (status.loggedIn) break;
          if (login.state === 'failed') throw new Error(login.message ?? 'Claude Code couldn’t sign in');
          if (status.login === null) throw new Error('The sign-in was stopped.');
          set({ step: 'signing-in', login });
        }
      }
      const account = status.account;
      set({ step: 'connecting', restarting: false, account });
      await connectClaudeProvider(bridge, (step) => live() && set({ step: 'connecting', restarting: step === 'restarting', account }));
      if (!live()) return;
      set({ step: 'idle' });
      hooks.onConnected(account);
    } catch (error) {
      if (live()) set({ step: 'failed', message: cleanAssistantError(error) });
    }
  })();
}

/** Stop the run, and the sign-in if it's at that. */
export function cancelClaudeSetup(): void {
  const signingIn = state.step === 'signing-in';
  run++;
  set({ step: 'idle' });
  if (signingIn) void getAssistantBridge()?.claudeCancel().catch(() => {});
}

/** Give the sign-in the code its page for other devices showed. */
export function sendClaudeCode(code: string): Promise<void> {
  const bridge = getAssistantBridge();
  if (!bridge) return Promise.reject(new Error('Claude needs Din’s desktop app'));
  return bridge.claudeCode(code);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useClaudeSetup(): ClaudeSetupState {
  return useSyncExternalStore(subscribe, () => state);
}
