import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm];

/**
 * The agent's replies, as Markdown. react-markdown builds React elements and
 * leaves raw HTML out, so nothing the model writes reaches the DOM as
 * markup; links open through Din's router, and only http(s) ones.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const openUrl = useOpenUrl();

  const components: Components = {
    a: ({ href, children }) => {
      const url = href ? sanitizeNavigationUrl(href) : null;
      if (!url) return <span className="underline decoration-dotted">{children}</span>;
      return (
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault();
            openUrl(url);
          }}
          className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {children}
        </a>
      );
    },
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
        {children}
      </pre>
    ),
    code: ({ className: language, children, ...props }: ComponentProps<'code'>) => {
      // Fenced blocks carry a language class or span lines; the rest is inline.
      const block = Boolean(language) || String(children).includes('\n');
      if (block) return <code className="font-mono">{children}</code>;
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]" {...props}>
          {children}
        </code>
      );
    },
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
    h1: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h3>,
    h3: ({ children }) => <h4 className="mb-1.5 mt-3 font-semibold first:mt-0">{children}</h4>,
    h4: ({ children }) => <h4 className="mb-1.5 mt-3 font-semibold first:mt-0">{children}</h4>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
    ),
    hr: () => <hr className="my-4 border-border/60" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border border-border/60 px-2 py-1 align-top">{children}</td>,
    // Pictures the model names could be anything, from anywhere: a link instead.
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? sanitizeNavigationUrl(src) : null;
      return url ? (
        <a href={url} onClick={(e) => { e.preventDefault(); openUrl(url); }} className="text-primary underline">
          {alt || url}
        </a>
      ) : null;
    },
  };

  return (
    <div className={cn('break-words leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
