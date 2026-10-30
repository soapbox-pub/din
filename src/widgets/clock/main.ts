import '../shared/base.css';
import './style.css';
import { followShape, followTheme } from '../shared/napplet';
import { fill, h, s } from '../shared/dom';

followTheme();

const root = document.querySelector<HTMLElement>('.clock')!;

const timeParts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/** A clear analog face: a faint disc, white markers and hands, an orange second hand. */
function face(): { el: SVGElement; set(now: Date): void } {
  const markers = Array.from({ length: 12 }, (_, i) =>
    s('line', { class: i % 3 === 0 ? 'marker major' : 'marker', x1: 100, x2: 100, y1: 14, y2: i % 3 === 0 ? 32 : 26, transform: `rotate(${i * 30} 100 100)` }),
  );
  const hour = s('line', { class: 'hand hour', x1: 100, y1: 100, x2: 100, y2: 56 });
  const minute = s('line', { class: 'hand minute', x1: 100, y1: 100, x2: 100, y2: 30 });
  const second = s('g', { class: 'second' }, s('line', { x1: 100, y1: 118, x2: 100, y2: 24 }), s('circle', { cx: 100, cy: 100, r: 4.5 }));
  const el = s(
    'svg',
    { class: 'face', viewBox: '0 0 200 200', 'aria-hidden': 'true' },
    s('circle', { class: 'disc', cx: 100, cy: 100, r: 96 }),
    ...markers,
    hour,
    minute,
    second,
    s('circle', { class: 'pin', cx: 100, cy: 100, r: 2 }),
  );
  return {
    el,
    set(now) {
      const sec = now.getSeconds();
      const min = now.getMinutes() + sec / 60;
      const hr = (now.getHours() % 12) + min / 60;
      hour.setAttribute('transform', `rotate(${hr * 30} 100 100)`);
      minute.setAttribute('transform', `rotate(${min * 6} 100 100)`);
      second.setAttribute('transform', `rotate(${sec * 6} 100 100)`);
    },
  };
}

let render: (now: Date) => void = () => {};

function build(): void {
  const shape = document.body.dataset.shape;
  if (shape === 'wide') {
    // Large digits, the day period small beside them, the date below.
    const time = h('span', { class: 'digits tabular' });
    const period = h('span', { class: 'period' });
    const date = h('div', { class: 'date' });
    fill(root, h('div', { class: 'digital' }, h('div', { class: 'time' }, time, period), date));
    render = (now) => {
      const parts = timeParts.formatToParts(now);
      time.textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
      period.textContent = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
      date.textContent = dateFormat.format(now);
    };
  } else {
    const analog = face();
    const date = shape === 'large' ? h('div', { class: 'date' }) : null;
    fill(root, analog.el, date);
    render = (now) => {
      analog.set(now);
      if (date) date.textContent = dateFormat.format(now);
    };
  }
  const now = new Date();
  root.setAttribute('aria-label', `${timeParts.format(now)}, ${dateFormat.format(now)}`);
  render(now);
}

followShape(build);
build();

function tick(): void {
  const now = new Date();
  render(now);
  root.setAttribute('aria-label', `${timeParts.format(now)}, ${dateFormat.format(now)}`);
  setTimeout(tick, 1000 - (Date.now() % 1000));
}
tick();
