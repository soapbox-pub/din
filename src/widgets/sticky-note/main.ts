import '../shared/base.css';
import './style.css';
import { napplet } from '../shared/napplet';

/** Paper colors, each with ink dark enough to read on it. */
const COLORS = {
  yellow: { paper: '#fef08a', ink: '#422006', label: 'Yellow' },
  pink: { paper: '#fbcfe8', ink: '#500724', label: 'Pink' },
  blue: { paper: '#bfdbfe', ink: '#172554', label: 'Blue' },
  green: { paper: '#bbf7d0', ink: '#052e16', label: 'Green' },
  violet: { paper: '#ddd6fe', ink: '#2e1065', label: 'Violet' },
} as const;
type Color = keyof typeof COLORS;

const textarea = document.querySelector('textarea')!;
const picker = document.querySelector('.colors')!;
const store = napplet.storage?.instance;

function setColor(color: Color): void {
  const { paper, ink } = COLORS[color];
  document.documentElement.style.setProperty('--paper', paper);
  document.documentElement.style.setProperty('--ink', ink);
  for (const button of picker.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.color === color));
  }
}

for (const [color, { paper, label }] of Object.entries(COLORS)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.role = 'radio';
  button.dataset.color = color;
  button.style.background = paper;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => {
    setColor(color as Color);
    void store?.setItem('color', color);
  });
  picker.append(button);
}

let saveTimer = 0;
textarea.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void store?.setItem('text', textarea.value), 400);
});
textarea.addEventListener('blur', () => {
  clearTimeout(saveTimer);
  void store?.setItem('text', textarea.value);
});

setColor('yellow');
if (store) {
  void Promise.all([store.getItem('text'), store.getItem('color')]).then(([text, color]) => {
    textarea.value = text ?? '';
    if (color && color in COLORS) setColor(color as Color);
    textarea.disabled = false;
  }, () => {
    textarea.disabled = false;
  });
} else {
  textarea.disabled = false;
}
