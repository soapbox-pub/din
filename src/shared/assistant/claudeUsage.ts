/**
 * The Claude plan's usage (electron/claude-code.mts): how much of its session
 * and weekly limits is used, for the Claude provider's row in Settings →
 * Assistant, the model picker while a Claude model is chosen, and
 * `din assistant claude-usage`.
 */

import { useQuery } from '@tanstack/react-query';
import { getAssistantBridge, type ClaudeUsage, type ClaudeUsageLimit } from '@/lib/assistant';

/** How often a usage shown on screen is asked for again. */
const REFRESH_MS = 60_000;

export const claudeUsageKey = ['assistant', 'claude-usage'] as const;

/** The plan's usage, while `enabled` (Claude connected), asked again every minute. */
export function useClaudeUsage(enabled: boolean) {
  return useQuery({
    queryKey: claudeUsageKey,
    queryFn: async (): Promise<ClaudeUsage> => {
      const bridge = getAssistantBridge();
      if (!bridge) throw new Error('Claude’s usage needs Din’s desktop app');
      return bridge.claudeUsage();
    },
    enabled: enabled && getAssistantBridge() !== null,
    refetchInterval: REFRESH_MS,
    staleTime: 30_000,
    retry: false,
  });
}

/** "Max", "Pro"… */
export function planName(plan: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** When a limit starts over: "in 2 hr 14 min" within a day, else "Fri 3:00 PM". */
export function resetWording(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'Resets now';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `Resets in ${hours} hr${rest ? ` ${rest} min` : ''}`;
  }
  return `Resets ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

/** A limit near its end, by Anthropic's say or, without it, by how much is used. */
export function limitTone(limit: ClaudeUsageLimit): 'normal' | 'warning' | 'critical' {
  const severity = limit.severity?.toLowerCase();
  if (severity === 'critical' || severity === 'exceeded' || limit.percent >= 100) return 'critical';
  if (severity === 'warning' || severity === 'high' || limit.percent >= 80) return 'warning';
  return 'normal';
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return amount.toLocaleString(undefined, { style: 'currency', currency });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The usage as lines of text, for the `din` command. */
export function usageText(usage: ClaudeUsage): string {
  const plan = planName(usage.plan);
  const lines = plan ? [`plan: Claude ${plan}`] : [];
  if (usage.limits.length === 0) lines.push('No limits reported');
  for (const limit of usage.limits) {
    const reset = resetWording(limit.resetsAt);
    lines.push(`${limit.label}: ${Math.round(limit.percent)}% used${reset ? ` (${reset.toLowerCase()})` : ''}`);
  }
  if (usage.extra) {
    const { used, limit, currency } = usage.extra;
    lines.push(`extra usage: ${formatMoney(used, currency)}${limit !== null ? ` of ${formatMoney(limit, currency)}` : ''}`);
  }
  return lines.join('\n');
}
