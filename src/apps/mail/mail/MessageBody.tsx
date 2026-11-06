import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { prepareHtml } from './sanitize';

/** An HTML message in a sandboxed frame that grows to its content's height. */
export function HtmlBody({ html, allowRemote, onRemote, onLink }: { html: string; allowRemote: boolean; onRemote: (has: boolean) => void; onLink: (href: string) => void }) {
  const prepared = useMemo(() => prepareHtml(html, allowRemote), [html, allowRemote]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const link = useRef(onLink);
  useLayoutEffect(() => {
    link.current = onLink;
  });

  useEffect(() => onRemote(prepared.hasRemote), [prepared.hasRemote, onRemote]);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (doc?.documentElement) setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 60));
    };
    const onLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      if (doc.body) observer.observe(doc.body);
      doc.addEventListener('load', measure, true);
      doc.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a[href]');
        if (!a) return;
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) return;
        e.preventDefault();
        link.current(href);
      });
    };
    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [prepared.html]);

  return (
    <iframe
      ref={frame}
      title="Message"
      sandbox="allow-same-origin"
      srcDoc={prepared.html}
      referrerPolicy="no-referrer"
      className="block w-full rounded-lg border-0 bg-white"
      style={{ height }}
    />
  );
}

const URL_RE = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])|\b(mailto:[^\s<>"')]+)/gi;

function linkify(text: string, onLink: (href: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const href = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={m.index}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          onLink(href);
        }}
        className="text-ink-accent underline-offset-2 hover:underline"
      >
        {href}
      </a>,
    );
    last = m.index + href.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A plain text message, links live and quoted lines under a bar, Apple Mail style. */
export function TextBody({ text, onLink }: { text: string; onLink: (href: string) => void }) {
  const blocks = useMemo(() => {
    const out: { depth: number; lines: string[] }[] = [];
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
      const depth = /^(\s*>)+/.exec(raw)?.[0].replace(/[^>]/g, '').length ?? 0;
      const line = depth ? raw.replace(/^(\s*>\s?)+/, '') : raw;
      const prev = out.at(-1);
      if (prev && prev.depth === depth) prev.lines.push(line);
      else out.push({ depth, lines: [line] });
    }
    return out;
  }, [text]);

  return (
    <div className="px-6 pt-5 pb-8 text-[15px] leading-relaxed break-words whitespace-pre-wrap select-text">
      {blocks.map((b, i) =>
        b.depth ? (
          <blockquote key={i} className="my-1 border-l-2 border-ink-accent/60 pl-3 text-muted-foreground" style={{ marginLeft: (b.depth - 1) * 12 }}>
            {linkify(b.lines.join('\n'), onLink)}
          </blockquote>
        ) : (
          <div key={i}>{linkify(b.lines.join('\n'), onLink)}</div>
        ),
      )}
    </div>
  );
}
