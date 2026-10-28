/**
 * Agents' colors, chosen the way OpenCode's terminal chooses them so the two
 * agree: an agent's own `color` if it has one, else the hue at its place
 * among the agents the server lists, from the theme's order for light or
 * dark. The hues match OpenCode's; the shades are Din's, picked to read as
 * text on Din's light and dark backgrounds (at least 4.5:1).
 */

type Hue = 'blue' | 'purple' | 'green' | 'orange' | 'red';

const ORDER: Record<'light' | 'dark', Hue[]> = {
  light: ['purple', 'orange', 'green', 'blue', 'red'],
  dark: ['blue', 'purple', 'green', 'orange', 'red'],
};

const SHADES: Record<Hue, { light: string; dark: string }> = {
  blue: { light: '#2563eb', dark: '#60a5fa' },
  purple: { light: '#7c3aed', dark: '#a78bfa' },
  green: { light: '#15803d', dark: '#4ade80' },
  orange: { light: '#b45309', dark: '#fb923c' },
  red: { light: '#dc2626', dark: '#f87171' },
};

/**
 * `agent`'s color, given every agent the server lists that isn't hidden
 * (subagents too: they take places in the order).
 */
export function agentColor(agents: { id: string; color?: string | null }[], agent: string, dark: boolean): string {
  const index = Math.max(0, agents.findIndex((a) => a.id === agent));
  const own = agents[index]?.color;
  if (own) return own;
  const mode = dark ? 'dark' : 'light';
  const order = ORDER[mode];
  return SHADES[order[index % order.length]][mode];
}
