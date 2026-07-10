import { useEffect, useState } from 'react';
import { useSeoMeta } from '@unhead/react';

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return now;
}

const Index = () => {
  const now = useClock();

  useSeoMeta({
    title: 'webOS demo',
    description: 'A minimal Linux system whose entire UI is a web app.',
  });

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0b0f14]">
      {/* Backdrop glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,#16222e,transparent)]"
      />

      <main className="relative flex min-h-screen flex-col items-center justify-center px-8 text-center">
        <h1 className="bg-gradient-to-r from-sky-400 to-emerald-400 bg-clip-text text-5xl font-bold tracking-tight text-transparent md:text-7xl">
          Hello from webOS demo
        </h1>

        <p className="mt-4 text-lg text-slate-400 md:text-xl">
          Linux &rarr; cage &rarr; Electron &mdash; the entire UI is this web page.
        </p>

        <time
          dateTime={now.toISOString()}
          className="mt-10 text-4xl font-semibold tabular-nums text-slate-100 md:text-5xl"
        >
          {now.toLocaleTimeString()}
        </time>
      </main>
    </div>
  );
};

export default Index;
