import '../shared/base.css';
import './style.css';
import { followShape, followTheme, instanceStore, napplet } from '../shared/napplet';
import { fill, h, icon } from '../shared/dom';
import { condition, weatherIcon } from './icons';

followTheme();

const root = document.querySelector<HTMLElement>('.weather')!;
const REFRESH_MS = 30 * 60_000;
const PIN = ['M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0', 'M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'];
const SEARCH = ['m21 21-4.34-4.34', 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'];

interface Place {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
}

interface Forecast {
  at: number;
  current: { temperature_2m: number; weather_code: number; is_day: number };
  hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; is_day: number[] };
  daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
  utc_offset_seconds: number;
}

/** Fahrenheit where people use it. */
const fahrenheit = (() => {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW'].includes(region ?? '');
  } catch {
    return false;
  }
})();

let place: Place | null = null;
let forecast: Forecast | null = null;
let error: string | null = null;
let searching = false;

async function getJson<T>(url: string): Promise<T> {
  if (!napplet.resource) throw new Error('no-internet');
  const blob = await napplet.resource.bytes(url);
  return JSON.parse(await blob.text()) as T;
}

async function refresh(): Promise<void> {
  if (!place) return;
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '6',
    temperature_unit: fahrenheit ? 'fahrenheit' : 'celsius',
  });
  try {
    const data = await getJson<Omit<Forecast, 'at'>>(`https://api.open-meteo.com/v1/forecast?${params}`);
    forecast = { ...data, at: Date.now() };
    error = null;
    instanceStore.set('forecast', forecast);
  } catch (e) {
    error = e instanceof Error && e.message === 'no-internet' ? 'no-internet' : 'Couldn\'t get the weather.';
  }
  render();
}

const degrees = (t: number) => `${Math.round(t)}°`;

/** "Now", then the next hours, from the hourly forecast in the place's own time. */
function hours(f: Forecast, count: number): { label: string; temp: number; code: number; day: boolean }[] {
  const nowThere = Date.now() + f.utc_offset_seconds * 1000;
  const start = f.hourly.time.findIndex((t) => Date.parse(`${t}Z`) + 3_600_000 > nowThere);
  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });
  return f.hourly.time.slice(Math.max(0, start), Math.max(0, start) + count).map((t, i) => {
    const at = Math.max(0, start) + i;
    return { label: i === 0 ? 'Now' : fmt.format(new Date(`${t}Z`)), temp: f.hourly.temperature_2m[at], code: f.hourly.weather_code[at], day: f.hourly.is_day[at] === 1 };
  });
}

function summary(f: Forecast, compact: boolean): HTMLElement {
  const now = condition(f.current.weather_code, f.current.is_day === 1);
  const hi = f.daily.temperature_2m_max[0];
  const lo = f.daily.temperature_2m_min[0];
  const change = h('button', { type: 'button', class: 'place', 'aria-label': `${place?.name}. Change place` }, h('span', {}, place?.name ?? ''), icon(PIN, { class: 'pin' }));
  change.addEventListener('click', () => {
    searching = true;
    render();
  });
  return h(
    'div',
    { class: `summary${compact ? ' compact' : ''}` },
    h('div', { class: 'top' }, change, compact ? null : weatherIcon(now.icon, 'big')),
    h('div', { class: 'temp tabular' }, degrees(f.current.temperature_2m)),
    h('div', { class: 'cond' }, compact ? weatherIcon(now.icon, 'small') : null, now.label),
    h('div', { class: 'hilo tabular' }, `H:${degrees(hi)}  L:${degrees(lo)}`),
  );
}

function hourly(f: Forecast): HTMLElement {
  return h('div', { class: 'hours' }, ...hours(f, 6).map((hr) =>
    h('div', { class: 'hour' }, h('div', { class: 'label' }, hr.label), weatherIcon(condition(hr.code, hr.day).icon), h('div', { class: 'tabular' }, degrees(hr.temp))),
  ));
}

function daily(f: Forecast): HTMLElement {
  const lows = f.daily.temperature_2m_min;
  const highs = f.daily.temperature_2m_max;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
  return h('div', { class: 'days' }, ...f.daily.time.slice(0, 5).map((t, i) => {
    const left = ((lows[i] - min) / (max - min || 1)) * 100;
    const width = ((highs[i] - lows[i]) / (max - min || 1)) * 100;
    const bar = h('span', { class: 'bar' });
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(width, 6)}%`;
    return h(
      'div',
      { class: 'day' },
      h('div', { class: 'name' }, i === 0 ? 'Today' : fmt.format(new Date(`${t}T12:00Z`))),
      weatherIcon(condition(f.daily.weather_code[i], true).icon),
      h('div', { class: 'lo tabular' }, degrees(lows[i])),
      h('div', { class: 'range' }, bar),
      h('div', { class: 'hi tabular' }, degrees(highs[i])),
    );
  }));
}

/** Choosing a place: search Open-Meteo's places and pick one. */
function search(): HTMLElement {
  const input = h('input', { type: 'search', placeholder: 'City', 'aria-label': 'Search for a city', autocomplete: 'off', spellcheck: 'false' });
  const results = h('ul', { class: 'results', role: 'listbox', 'aria-label': 'Places' });
  const note = h('p', { class: 'note' });
  let timer = 0;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      fill(results);
      note.textContent = 'Search for a city to see its weather.';
      return;
    }
    timer = window.setTimeout(async () => {
      const mine = ++seq;
      try {
        const data = await getJson<{ results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] }>(
          `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query, count: '5', language: navigator.language.split('-')[0] })}`,
        );
        if (mine !== seq) return;
        note.textContent = data.results?.length ? '' : 'No places found.';
        fill(results, ...(data.results ?? []).map((r) => {
          const region = [r.admin1, r.country].filter(Boolean).join(', ');
          const item = h('li', {}, h('button', { type: 'button', role: 'option' }, h('span', { class: 'city' }, r.name), h('span', { class: 'region' }, region)));
          item.querySelector('button')!.addEventListener('click', () => {
            place = { name: r.name, region, latitude: r.latitude, longitude: r.longitude };
            instanceStore.set('place', place);
            forecast = null;
            searching = false;
            render();
            void refresh();
          });
          return item;
        }));
      } catch {
        note.textContent = 'Couldn\'t search for places.';
      }
    }, 300);
  });
  const cancel = place ? h('button', { type: 'button', class: 'cancel' }, 'Cancel') : null;
  cancel?.addEventListener('click', () => {
    searching = false;
    render();
  });
  // Only when asked for: a widget shouldn't take the keyboard by itself.
  if (searching) queueMicrotask(() => input.focus());
  note.textContent = 'Search for a city to see its weather.';
  return h('div', { class: 'search' }, h('div', { class: 'field' }, icon(SEARCH), input, cancel), results, note);
}

function render(): void {
  const shape = document.body.dataset.shape;
  if (!napplet.resource || error === 'no-internet') {
    root.dataset.sky = 'cloudy';
    fill(root, h('div', { class: 'message' }, h('strong', {}, 'Weather needs the internet'), h('span', {}, 'Turn it on in About This Widget.')));
    return;
  }
  if (!place || searching) {
    root.dataset.sky = 'clear';
    fill(root, search());
    return;
  }
  if (!forecast) {
    root.dataset.sky = 'clear';
    fill(root, h('div', { class: 'message' }, h('strong', {}, place.name), h('span', {}, error ?? 'Getting the weather…')));
    return;
  }
  const now = condition(forecast.current.weather_code, forecast.current.is_day === 1);
  root.dataset.sky = forecast.current.is_day === 1 ? now.sky : 'night';
  root.setAttribute('aria-label', `${place.name}: ${degrees(forecast.current.temperature_2m)}, ${now.label}`);
  if (shape === 'small') fill(root, summary(forecast, true));
  else if (shape === 'wide') fill(root, summary(forecast, false), hourly(forecast));
  else fill(root, summary(forecast, false), hourly(forecast), daily(forecast));
}

followShape(render);
render();

void Promise.all([instanceStore.get<Place | null>('place', null), instanceStore.get<Forecast | null>('forecast', null)]).then(([savedPlace, saved]) => {
  if (savedPlace && typeof savedPlace.latitude === 'number') place = savedPlace;
  if (saved && typeof saved.at === 'number' && saved.current) forecast = saved;
  render();
  if (place && (!forecast || Date.now() - forecast.at > REFRESH_MS)) void refresh();
});

setInterval(() => void refresh(), REFRESH_MS);
