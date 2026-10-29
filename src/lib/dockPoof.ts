/** How long the cloud takes to billow out and fade, in ms. */
const DURATION = 480;
/** Puffs around the cloud's edge, besides the one in the middle. */
const PUFFS = 7;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Make a dragged-off Dock tile vanish in a puff of smoke, as on macOS: the
 * copy under the pointer shrinks away while a little cloud billows out from
 * where it was and fades. Takes over `ghost` and removes it when it's done.
 */
export function poof(ghost: HTMLElement): void {
  const parent = ghost.parentElement;
  if (!parent || prefersReducedMotion()) {
    ghost.remove();
    return;
  }
  const rect = ghost.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);

  ghost
    .animate(
      [
        { scale: '1', opacity: '0.95' },
        { scale: '0.3', opacity: '0' },
      ],
      { duration: DURATION / 3, easing: 'ease-in', fill: 'forwards' },
    )
    .finished.finally(() => ghost.remove());

  const cloud = document.createElement('div');
  cloud.setAttribute('aria-hidden', 'true');
  Object.assign(cloud.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  parent.appendChild(cloud);
  // Fixed elements aren't always placed against the viewport (see the
  // ghost's own origin in useDragReorder), so center it by measuring.
  const origin = cloud.getBoundingClientRect();
  cloud.style.transform = `translate(${rect.left + rect.width / 2 - origin.left}px, ${rect.top + rect.height / 2 - origin.top}px)`;

  const reach = size * 0.45;
  const animations = Array.from({ length: PUFFS + 1 }, (_, i) => {
    const center = i === PUFFS;
    const angle = (i / PUFFS) * Math.PI * 2 - Math.PI / 2;
    const x = center ? 0 : Math.cos(angle) * reach;
    const y = center ? 0 : Math.sin(angle) * reach * 0.8;
    const diameter = size * (center ? 0.75 : 0.45 + ((i * 37) % 10) / 50);
    const puff = document.createElement('div');
    Object.assign(puff.style, {
      position: 'absolute',
      left: `${-diameter / 2}px`,
      top: `${-diameter / 2}px`,
      width: `${diameter}px`,
      height: `${diameter}px`,
      borderRadius: '50%',
      background: 'radial-gradient(circle at 35% 35%, rgb(255 255 255), rgb(226 228 233) 60%, rgb(190 194 202 / 0.9))',
      boxShadow: '0 2px 6px rgb(0 0 0 / 0.15)',
    });
    cloud.appendChild(puff);
    return puff.animate(
      [
        { transform: `translate(${x * 0.2}px, ${y * 0.2}px) scale(0.2)`, opacity: 0 },
        { transform: `translate(${x * 0.7}px, ${y * 0.7}px) scale(0.9)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${x * 1.3}px, ${y * 1.3 - size * 0.15}px) scale(1.15)`, opacity: 0 },
      ],
      { duration: DURATION, delay: center ? 0 : (i % 3) * 20, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
    );
  });
  Promise.allSettled(animations.map((a) => a.finished)).then(() => cloud.remove());
}
