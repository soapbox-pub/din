import '../shared/base.css';
import './style.css';
import { followShape, followTheme } from '../shared/napplet';
import { fill, h, icon } from '../shared/dom';

followTheme();

const root = document.querySelector<HTMLElement>('.calendar')!;
const locale = navigator.language;

/** The first day of the week where the user is: 0 Sunday … 6 Saturday. */
function firstDay(): number {
  try {
    const info = (new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } });
    const day = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 7;
    return day % 7;
  } catch {
    return 0;
  }
}
const FIRST = firstDay();

/** The month being shown (the large size can page through months). */
let shown = new Date();
shown.setDate(1);

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A month's grid: weekday initials, then its days, today circled. */
function grid(month: Date, today: Date, compact: boolean): HTMLElement {
  const narrow = new Intl.DateTimeFormat(locale, { weekday: compact ? 'narrow' : 'short' });
  const heads = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 7 + ((FIRST + i) % 7)); // 2024-01-07 is a Sunday
    return h('div', { class: 'head muted', role: 'columnheader' }, narrow.format(d));
  });
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (start.getDay() - FIRST + 7) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: HTMLElement[] = [];
  for (let i = 0; i < offset; i++) cells.push(h('div', { class: 'day empty', 'aria-hidden': 'true' }));
  const label = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  for (let d = 1; d <= days; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    cells.push(h('div', {
      class: `day tabular${sameDay(date, today) ? ' today' : ''}${weekend ? ' weekend' : ''}`,
      role: 'gridcell',
      'aria-label': label.format(date),
      'aria-current': sameDay(date, today) ? 'date' : undefined,
    }, String(d)));
  }
  return h('div', { class: 'grid', role: 'grid' }, ...heads, ...cells);
}

/** Today, big: the weekday in red, the date, the month. */
function today(now: Date): HTMLElement {
  return h(
    'div',
    { class: 'today-card' },
    h('div', { class: 'weekday' }, new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)),
    h('div', { class: 'number tabular' }, String(now.getDate())),
    h('div', { class: 'month muted' }, new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(now)),
  );
}

function render(): void {
  const now = new Date();
  const shape = document.body.dataset.shape;
  if (shape === 'small') {
    fill(root, today(now));
  } else if (shape === 'wide') {
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    fill(root, today(now), h('div', { class: 'side' }, grid(month, now, true)));
  } else {
    const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(shown);
    const page = (delta: number) => {
      shown = new Date(shown.getFullYear(), shown.getMonth() + delta, 1);
      render();
    };
    const button = (label: string, paths: string[], onClick: () => void) => {
      const b = h('button', { type: 'button', class: 'nav', 'aria-label': label }, icon(paths));
      b.addEventListener('click', onClick);
      return b;
    };
    const isThisMonth = shown.getFullYear() === now.getFullYear() && shown.getMonth() === now.getMonth();
    const todayButton = h('button', { type: 'button', class: 'nav today-button', disabled: isThisMonth }, 'Today');
    todayButton.addEventListener('click', () => {
      shown = new Date(now.getFullYear(), now.getMonth(), 1);
      render();
    });
    fill(
      root,
      h(
        'header',
        {},
        h('div', { class: 'title' }, title),
        h('div', { class: 'navs' }, button('Previous month', ['m15 18-6-6 6-6'], () => page(-1)), todayButton, button('Next month', ['m9 18 6-6-6-6'], () => page(1))),
      ),
      grid(shown, now, false),
    );
  }
}

followShape(render);
render();

// Past midnight, it's a new day.
function atMidnight(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  setTimeout(() => {
    render();
    atMidnight();
  }, next.getTime() - now.getTime() + 500);
}
atMidnight();
