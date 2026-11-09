import { lazy, Suspense, useEffect, useState } from 'react';
import { useDin } from '@/sdk/react';
import { Basic } from './calculator/Basic';
import { loadBasicState, saveBasicState, type CalculatorView } from './calculator/state';

/**
 * The advanced calculator, loaded the first time it's shown: its graphs,
 * computer algebra and typesetting (KaTeX) are most of the app's code, which
 * a window showing the basic calculator doesn't need.
 */
const Advanced = lazy(() => import('./calculator/Advanced').then((m) => ({ default: m.Advanced })));

/** The window size each calculator opens at. */
const VIEW_SIZES: Record<CalculatorView, { width: number; height: number }> = {
  basic: { width: 380, height: 620 },
  advanced: { width: 1160, height: 720 },
};

/**
 * Calculator - a basic calculator by default (calculator/Basic.tsx), and, a
 * click away, the advanced one: a graphing calculator with a computer
 * algebra system, built to stand in for a TI-89.
 */
export function Calculator() {
  const [basic, setBasic] = useState(loadBasicState);
  useEffect(() => saveBasicState(basic), [basic]);
  const setView = (view: CalculatorView) => setBasic((b) => ({ ...b, view }));

  return (
    <>
      <FitWindow view={basic.view} />
      {basic.view === 'basic' ? (
        <Basic tape={basic.tape} onTape={(tape) => setBasic((b) => ({ ...b, tape }))} onView={setView} />
      ) : (
        <Suspense>
          <Advanced onView={setView} />
        </Suspense>
      )}
    </>
  );
}

/** Sizes the window for the calculator it shows, keeping it on its monitor. */
function FitWindow({ view }: { view: CalculatorView }) {
  const din = useDin();
  useEffect(() => {
    if (matchMedia('(display-state: maximized)').matches || din.window.snapped) return;
    const bounds = { x: screenX, y: screenY, width: outerWidth, height: outerHeight };
    const workArea = { x: screen.availLeft, y: screen.availTop, width: screen.availWidth, height: screen.availHeight };
    let { width, height } = VIEW_SIZES[view];
    if (bounds.width === width && bounds.height === height) return;
    width = Math.min(width, workArea.width);
    height = Math.min(height, workArea.height);
    const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
    window.moveTo(x, y);
    window.resizeTo(width, height);
  }, [din, view]);

  return null;
}
