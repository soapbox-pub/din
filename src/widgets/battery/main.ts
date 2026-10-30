import '../shared/base.css';
import './style.css';
import { followShape, followTheme } from '../shared/napplet';
import { fill, h, icon, s } from '../shared/dom';

followTheme();

interface BatteryManager extends EventTarget {
  charging: boolean;
  level: number;
  chargingTime: number;
  dischargingTime: number;
}

const root = document.querySelector<HTMLElement>('.battery')!;
const BOLT = ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'];

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** What to say about it: charging, how long left, or full. */
function status(b: BatteryManager): { title: string; detail: string } {
  if (b.charging) {
    // Full and plugged in reads the same as a machine with no battery at all.
    if (b.level >= 1 || b.chargingTime === 0) return { title: 'Charged', detail: 'Plugged in' };
    return {
      title: 'Charging',
      detail: Number.isFinite(b.chargingTime) && b.chargingTime > 0 ? `${duration(b.chargingTime)} until full` : 'Plugged in',
    };
  }
  return {
    title: 'On battery',
    detail: Number.isFinite(b.dischargingTime) ? `${duration(b.dischargingTime)} left` : 'Working out time left',
  };
}

/** The ring: the level around it, the percentage (or a plug) inside. */
function ring(b: BatteryManager | null): HTMLElement {
  const level = b?.level ?? 0;
  const low = !!b && !b.charging && level <= 0.2;
  const r = 44;
  const length = 2 * Math.PI * r;
  return h(
    'div',
    { class: 'ring' },
    s(
      'svg',
      { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      s('circle', { class: 'track', cx: 50, cy: 50, r }),
      s('circle', {
        class: `level${low ? ' low' : ''}`,
        cx: 50,
        cy: 50,
        r,
        'stroke-dasharray': `${length * level} ${length}`,
        transform: 'rotate(-90 50 50)',
      }),
    ),
    h(
      'div',
      { class: 'inside' },
      h('div', { class: 'percent tabular' }, b ? `${Math.round(level * 100)}` : '–', h('span', {}, '%')),
      b?.charging ? icon(BOLT, { class: 'bolt', fill: 'currentColor' }) : null,
    ),
  );
}

let battery: BatteryManager | null = null;

function render(): void {
  const info = battery ? status(battery) : { title: 'No battery', detail: 'This computer doesn\'t report one' };
  root.setAttribute('aria-label', battery ? `Battery ${Math.round(battery.level * 100)}%, ${info.title}, ${info.detail}` : info.title);
  if (document.body.dataset.shape === 'small') {
    fill(root, ring(battery), h('div', { class: 'caption' }, info.title));
  } else {
    fill(
      root,
      ring(battery),
      h('div', { class: 'text' }, h('div', { class: 'title' }, info.title), h('div', { class: 'detail muted' }, info.detail)),
    );
  }
}

followShape(render);
render();

const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
void nav.getBattery?.().then((b) => {
  battery = b;
  for (const event of ['chargingchange', 'levelchange', 'chargingtimechange', 'dischargingtimechange']) b.addEventListener(event, render);
  render();
}, () => {});
