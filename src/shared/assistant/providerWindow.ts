/**
 * The desktop's window for adding or reconnecting an AI provider (under
 * Settings in the Dock), opened from Settings → Assistant, the Assistant
 * app and the model picker alike. One window: opening it again points it
 * at the new provider, `null` for the list to pick from.
 */
export const PROVIDER_WINDOW_APP_ID = 'ai-provider';

/** Its launch params; `at` makes each opening a new request. */
export function providerWindowParams(provider: string | null = null): Record<string, unknown> {
  return { provider, at: Date.now() };
}
