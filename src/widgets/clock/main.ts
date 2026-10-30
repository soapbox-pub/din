import '../shared/base.css';
import './style.css';
import { followTheme } from '../shared/napplet';

followTheme();

const svg = 'http://www.w3.org/2000/svg';
const ticks = document.querySelector('.ticks')!;
for (let i = 0; i < 60; i++) {
  const major = i % 5 === 0;
  const line = document.createElementNS(svg, 'line');
  line.setAttribute('x1', '100');
  line.setAttribute('x2', '100');
  line.setAttribute('y1', major ? '10' : '12');
  line.setAttribute('y2', major ? '22' : '16');
  line.setAttribute('class', major ? 'tick major' : 'tick');
  line.setAttribute('transform', `rotate(${i * 6} 100 100)`);
  ticks.append(line);
}

const hands = {
  hour: document.querySelector<SVGLineElement>('.hour')!,
  minute: document.querySelector<SVGLineElement>('.minute')!,
  second: document.querySelector<SVGLineElement>('.second')!,
};
const label = document.querySelector('#time-label')!;
const weekday = document.querySelector('.weekday')!;
const time = document.querySelector('.time')!;
const date = document.querySelector('.date')!;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });

function render(): void {
  const now = new Date();
  const s = now.getSeconds();
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  hands.hour.setAttribute('transform', `rotate(${h * 30} 100 100)`);
  hands.minute.setAttribute('transform', `rotate(${m * 6} 100 100)`);
  hands.second.setAttribute('transform', `rotate(${s * 6} 100 100)`);
  const text = timeFormat.format(now);
  label.textContent = text;
  time.textContent = text;
  weekday.textContent = weekdayFormat.format(now);
  date.textContent = dateFormat.format(now);
}

function tick(): void {
  render();
  setTimeout(tick, 1000 - (Date.now() % 1000));
}
tick();

// Wide: the face beside the time and date. Tall enough: the date under the face.
function layout(): void {
  const { innerWidth: w, innerHeight: h } = window;
  document.body.dataset.layout = w > h * 1.5 ? 'wide' : h >= 280 ? 'tall' : 'face';
}
layout();
window.addEventListener('resize', layout);
