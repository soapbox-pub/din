/**
 * Claude for the assistant: OpenCode's built-in "Claude Agent" provider,
 * which runs the user's own Claude Code (and so their Claude plan) through
 * the Agent SDK. Din shows it as Claude and does every step for the user:
 * installing Claude Code, signing it in (electron/claude-code.mts), and
 * connecting OpenCode to it, here. Settings → Assistant, the Assistant's
 * Add provider and `din assistant claude` share these.
 */

import { assistantApi, credentialIDs, type AssistantBridge, type IntegrationInfo } from '@/lib/assistant';

export const CLAUDE_PROVIDER = 'claude-agent';
const CLAUDE_METHOD = 'claude-login';
/** How long OpenCode has to check Claude Code and list its models. */
const READY_TIMEOUT_MS = 60_000;

/** What a step of connecting is doing, for the UI to say. */
export type ClaudeConnectStep = 'connecting' | 'restarting';

/**
 * Connect OpenCode's Claude provider to the signed-in Claude Code, and wait
 * until its models are there. A connection made before is made again: that
 * has OpenCode check Claude Code afresh. An OpenCode server started before
 * Claude Code was installed doesn't know where it is; it's restarted once.
 */
export async function connectClaudeProvider(
  bridge: AssistantBridge,
  onStep: (step: ClaudeConnectStep) => void = () => {},
): Promise<void> {
  onStep('connecting');
  const before = await assistantApi.integration(CLAUDE_PROVIDER);
  await Promise.allSettled(credentialIDs(before).map((id) => assistantApi.removeCredential(id)));
  await assistantApi.connectExternal(CLAUDE_PROVIDER, CLAUDE_METHOD);

  let restarted = false;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const models = await assistantApi.models().catch(() => []);
    if (models.some((m) => m.providerID === CLAUDE_PROVIDER)) return;
    const problem = claudeProblem(await assistantApi.integration(CLAUDE_PROVIDER).catch(() => null));
    if (problem?.url && !restarted) {
      // "Not installed", with Claude Code's setup page: this server can't see it.
      restarted = true;
      onStep('restarting');
      await bridge.restart();
      onStep('connecting');
    } else if (problem && !problem.url) {
      throw new Error(problem.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('OpenCode didn’t find Claude Code’s models. Try again in a moment.');
}

function claudeProblem(integration: IntegrationInfo | null) {
  return integration?.connections.find((c) => c.status)?.status;
}
