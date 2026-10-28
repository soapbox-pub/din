import { memo, useLayoutEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '@/lib/utils';

/** Typeset math, the TI-89's “pretty print”. */
export const TeX = memo(function TeX({ tex, className, label }: { tex: string; className?: string; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // KaTeX escapes everything it's given and, with trust off, ignores
    // \href, \htmlClass and friends; there's no way to inject markup.
    katex.render(tex, el, {
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      maxSize: 50,
      maxExpand: 500,
      output: 'htmlAndMathml',
    });
  }, [tex]);
  return <span ref={ref} className={cn('calc-tex', className)} aria-label={label} />;
});
