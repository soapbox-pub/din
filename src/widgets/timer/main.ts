import '../shared/base.css';
import './style.css';
import { followShape, followTheme, instanceStore } from '../shared/napplet';
import { fill, h, icon, s } from '../shared/dom';

followTheme();

const root = document.querySelector<HTMLElement>('.timer')!;
const MINUTE = 60_000;
const PRESETS = [1, 3, 5, 10, 15, 25];

const PLAY = ['M6 4v16l14-8z'];
const PAUSE = ['M8 4v16', 'M16 4v16'];
const RESET = ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'];

interface State {
  /** What it counts down from. */
  duration: number;
  /** When it ends, while running. */
  endAt: number | null;
  /** What's left, while paused. */
  left: number;
}

let state: State = { duration: 5 * MINUTE, endAt: null, left: 5 * MINUTE };
let done = false;

function save(): void {
  instanceStore.set('state', state);
}

function remaining(now = Date.now()): number {
  return state.endAt === null ? state.left : Math.max(0, state.endAt - now);
}

function format(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

let audio: AudioContext | null = null;

/** Three soft chimes, twice. */
function chime(): void {
  if (!audio) return;
  const start = audio.currentTime + 0.05;
  for (let i = 0; i < 6; i++) {
    const at = start + i * 0.28 + (i >= 3 ? 0.5 : 0);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = i % 3 === 2 ? 1318.5 : 987.8;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  }
}

function start(): void {
  // Made in the click, so it may play when the time comes.
  audio ??= new AudioContext();
  void audio.resume();
  if (done || state.left <= 0) state.left = state.duration;
  done = false;
  state.endAt = Date.now() + state.left;
  save();
  render();
}

function pause(): void {
  state.left = remaining();
  state.endAt = null;
  save();
  render();
}

function reset(): void {
  done = false;
  state.endAt = null;
  state.left = state.duration;
  save();
  render();
}

function choose(minutes: number): void {
  done = false;
  state = { duration: minutes * MINUTE, endAt: null, left: minutes * MINUTE };
  save();
  render();
}

function button(label: string, paths: string[], onClick: () => void, className = 'round'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: className, 'aria-label': label }, icon(paths, { fill: paths === PLAY ? 'currentColor' : 'none' }));
  b.addEventListener('click', onClick);
  return b;
}

let ringLevel: SVGElement | null = null;
let ringText: HTMLElement | null = null;

function ring(): HTMLElement {
  const r = 44;
  ringLevel = s('circle', { class: 'level', cx: 50, cy: 50, r, transform: 'rotate(-90 50 50)', 'stroke-dasharray': `${2 * Math.PI * r} ${2 * Math.PI * r}` });
  ringText = h('div', { class: 'left tabular', role: 'timer', 'aria-live': 'off' });
  const running = state.endAt !== null;
  return h(
    'div',
    { class: `ring${done ? ' done' : ''}` },
    s('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, s('circle', { class: 'track', cx: 50, cy: 50, r }), ringLevel),
    h(
      'div',
      { class: 'inside' },
      ringText,
      document.body.dataset.shape === 'small'
        ? running ? button('Pause', PAUSE, pause, 'round small') : button(done ? 'Start again' : 'Start', PLAY, start, 'round small primary')
        : h('div', { class: 'of muted' }, done ? 'Done' : running || state.left < state.duration ? `of ${format(state.duration)}` : 'Ready'),
    ),
  );
}

function update(): void {
  const left = remaining();
  if (state.endAt !== null && left <= 0) {
    state.endAt = null;
    state.left = 0;
    done = true;
    save();
    chime();
    render();
    return;
  }
  if (ringText) ringText.textContent = done ? '0:00' : format(left);
  if (ringLevel) {
    const length = 2 * Math.PI * 44;
    const fraction = done ? 0 : left / state.duration;
    ringLevel.setAttribute('stroke-dasharray', `${length * fraction} ${length}`);
  }
}

function render(): void {
  const shape = document.body.dataset.shape;
  const running = state.endAt !== null;
  const paused = !running && !done && state.left < state.duration;
  if (shape === 'small') {
    fill(root, ring(), paused || done ? button('Reset', RESET, reset, 'round corner') : null);
  } else {
    const presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Minutes' }, ...PRESETS.map((m) => {
      const b = h('button', { type: 'button', class: `chip${state.duration === m * MINUTE ? ' on' : ''}`, 'aria-pressed': String(state.duration === m * MINUTE) }, `${m} min`);
      b.addEventListener('click', () => choose(m));
      return b;
    }));
    const main = running
      ? button('Pause', PAUSE, pause, 'pill')
      : button(done ? 'Start again' : paused ? 'Resume' : 'Start', PLAY, start, 'pill primary');
    main.append(running ? 'Pause' : done ? 'Again' : paused ? 'Resume' : 'Start');
    const controls = h('div', { class: 'controls' }, main, button('Reset', RESET, reset, 'round'));
    fill(root, ring(), h('div', { class: 'side' }, presets, controls));
  }
  update();
}

followShape(render);
render();
void instanceStore.get<State | null>('state', null).then((saved) => {
  if (saved && typeof saved.duration === 'number' && typeof saved.left === 'number') {
    state = { duration: saved.duration, left: saved.left, endAt: typeof saved.endAt === 'number' ? saved.endAt : null };
    // Ran out while the widget was away: done, without a chime nobody would hear.
    if (state.endAt !== null && state.endAt <= Date.now()) {
      state = { ...state, endAt: null, left: 0 };
      done = true;
    }
    render();
  }
});

setInterval(update, 250);
