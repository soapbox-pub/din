import '../shared/base.css';
import './style.css';
import { followShape, followTheme, instanceStore } from '../shared/napplet';
import { fill, h, icon, s } from '../shared/dom';

followTheme();

const root = document.querySelector<HTMLElement>('.world')!;

/** Cities to choose from, by time zone. */
const CITIES: [zone: string, name: string][] = [
  ['Pacific/Honolulu', 'Honolulu'], ['America/Anchorage', 'Anchorage'], ['America/Los_Angeles', 'Los Angeles'],
  ['America/Vancouver', 'Vancouver'], ['America/Denver', 'Denver'], ['America/Phoenix', 'Phoenix'],
  ['America/Chicago', 'Chicago'], ['America/Mexico_City', 'Mexico City'], ['America/New_York', 'New York'],
  ['America/Toronto', 'Toronto'], ['America/Bogota', 'Bogotá'], ['America/Sao_Paulo', 'São Paulo'],
  ['America/Argentina/Buenos_Aires', 'Buenos Aires'], ['Atlantic/Reykjavik', 'Reykjavík'], ['Europe/London', 'London'],
  ['Europe/Lisbon', 'Lisbon'], ['Europe/Paris', 'Paris'], ['Europe/Berlin', 'Berlin'], ['Europe/Madrid', 'Madrid'],
  ['Europe/Rome', 'Rome'], ['Europe/Amsterdam', 'Amsterdam'], ['Europe/Stockholm', 'Stockholm'], ['Europe/Athens', 'Athens'],
  ['Europe/Istanbul', 'Istanbul'], ['Europe/Kyiv', 'Kyiv'], ['Europe/Moscow', 'Moscow'], ['Africa/Cairo', 'Cairo'],
  ['Africa/Lagos', 'Lagos'], ['Africa/Nairobi', 'Nairobi'], ['Africa/Johannesburg', 'Johannesburg'], ['Asia/Dubai', 'Dubai'],
  ['Asia/Tehran', 'Tehran'], ['Asia/Karachi', 'Karachi'], ['Asia/Kolkata', 'Mumbai'], ['Asia/Dhaka', 'Dhaka'],
  ['Asia/Bangkok', 'Bangkok'], ['Asia/Singapore', 'Singapore'], ['Asia/Hong_Kong', 'Hong Kong'], ['Asia/Shanghai', 'Shanghai'],
  ['Asia/Taipei', 'Taipei'], ['Asia/Seoul', 'Seoul'], ['Asia/Tokyo', 'Tokyo'], ['Australia/Perth', 'Perth'],
  ['Australia/Adelaide', 'Adelaide'], ['Australia/Sydney', 'Sydney'], ['Pacific/Auckland', 'Auckland'],
];
const NAMES = new Map(CITIES);
const DEFAULTS = ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney', 'Asia/Kolkata'];
const MAX = 6;

let zones = DEFAULTS;
let editing = false;

function cityName(zone: string): string {
  return NAMES.get(zone) ?? zone.split('/').pop()!.replace(/_/g, ' ');
}

/** The wall-clock fields in a zone. */
function inZone(zone: string, now: Date): { hour: number; minute: number; second: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), day };
}

/** "Today, +3 h", "Tomorrow, +9 h", against here (just "+9 h", `short`). */
function relative(zone: string, now: Date, short = false): string {
  const there = inZone(zone, now);
  const here = inZone(Intl.DateTimeFormat().resolvedOptions().timeZone, now);
  const diffMinutes = (there.day - here.day) * 1440 + (there.hour - here.hour) * 60 + (there.minute - here.minute);
  const day = there.day === here.day ? 'Today' : there.day > here.day ? 'Tomorrow' : 'Yesterday';
  const hours = Math.round(diffMinutes / 30) / 2;
  const offset = `${hours > 0 ? '+' : '−'}${Math.abs(hours)} h`;
  if (short) return hours === 0 ? 'Here' : offset;
  return hours === 0 ? day : `${day}, ${offset}`;
}

const timeFormat = (zone: string) => new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' });

/** A small analog face: light by day, dark by night. */
function face(zone: string, now: Date): SVGElement {
  const { hour, minute } = inZone(zone, now);
  const day = hour >= 6 && hour < 18;
  const h12 = (hour % 12) + minute / 60;
  return s(
    'svg',
    { class: `mini ${day ? 'day' : 'night'}`, viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    s('circle', { class: 'disc', cx: 50, cy: 50, r: 48 }),
    ...Array.from({ length: 12 }, (_, i) => s('line', { class: 'tick', x1: 50, x2: 50, y1: 8, y2: i % 3 === 0 ? 16 : 13, transform: `rotate(${i * 30} 50 50)` })),
    s('line', { class: 'hand', 'stroke-width': 6, x1: 50, y1: 50, x2: 50, y2: 28, transform: `rotate(${h12 * 30} 50 50)` }),
    s('line', { class: 'hand', 'stroke-width': 4, x1: 50, y1: 50, x2: 50, y2: 16, transform: `rotate(${minute * 6} 50 50)` }),
    s('circle', { class: 'pin', cx: 50, cy: 50, r: 3.5 }),
  );
}

function editButton(): HTMLElement {
  const b = h('button', { type: 'button', class: 'edit', 'aria-label': 'Choose cities' }, icon(['M12 20h9', 'M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z']));
  b.addEventListener('click', () => {
    editing = true;
    render();
  });
  return b;
}

/** Choosing cities: a list of pickers, in the widget. */
function editor(): HTMLElement {
  const count = document.body.dataset.shape === 'large' ? MAX : 4;
  const selects = Array.from({ length: count }, (_, i) => {
    const select = h('select', { 'aria-label': `City ${i + 1}` }, h('option', { value: '' }, '—'), ...CITIES.map(([zone, name]) => h('option', { value: zone }, name)));
    select.value = zones[i] ?? '';
    return select;
  });
  const done = h('button', { type: 'button', class: 'done' }, 'Done');
  done.addEventListener('click', () => {
    const chosen = selects.map((sel) => sel.value).filter(Boolean);
    zones = [...new Set([...chosen, ...zones.slice(count)])].slice(0, MAX);
    if (zones.length === 0) zones = DEFAULTS;
    instanceStore.set('zones', zones);
    editing = false;
    render();
  });
  return h('div', { class: 'editor glass' }, h('div', { class: 'pickers' }, ...selects), done);
}

function render(): void {
  const now = new Date();
  const shape = document.body.dataset.shape;
  if (editing) {
    root.classList.remove('clear');
    fill(root, editor());
    return;
  }
  root.classList.add('clear');
  if (shape === 'large') {
    // A list: city and how far from here, then the time.
    fill(
      root,
      h('ul', { class: 'rows' }, ...zones.slice(0, MAX).map((zone) =>
        h('li', {},
          face(zone, now),
          h('div', { class: 'where' }, h('div', { class: 'city' }, cityName(zone)), h('div', { class: 'offset muted' }, relative(zone, now))),
          h('div', { class: 'digital tabular' }, timeFormat(zone).format(now)),
        ),
      )),
      editButton(),
    );
  } else {
    // Faces in a row (or two by two when small), named underneath.
    const shown = zones.slice(0, 4);
    fill(
      root,
      h('ul', { class: 'faces' }, ...shown.map((zone) =>
        h('li', { 'aria-label': `${cityName(zone)}, ${timeFormat(zone).format(now)}` },
          face(zone, now),
          h('div', { class: 'city' }, cityName(zone)),
          shape === 'wide' ? h('div', { class: 'offset muted' }, relative(zone, now, true)) : null,
        ),
      )),
      editButton(),
    );
  }
}

followShape(() => render());
void instanceStore.get<string[]>('zones', DEFAULTS).then((saved) => {
  zones = Array.isArray(saved) && saved.every((z) => typeof z === 'string') && saved.length > 0 ? saved : DEFAULTS;
  render();
});
render();

function tick(): void {
  if (!editing) render();
  setTimeout(tick, 60_000 - (Date.now() % 60_000));
}
setTimeout(tick, 60_000 - (Date.now() % 60_000));
