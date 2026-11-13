import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm];
/** Pictures would load from wherever the notes say, so they're left out with the raw HTML. */
const DISALLOWED = ['img'];

/**
 * A release's notes, as Markdown: react-markdown builds React elements and
 * skips raw HTML, so nothing a publisher writes reaches the DOM as markup.
 * Links open in the Web Browser, and only http(s) ones; headings are kept
 * small, under the page's own.
 */
export default function ReleaseNotes({ text, className }: { text: string; className?: string }) {
  const openUrl = useOpenUrl();
  const components: Components = {
    a: ({ href, children }) => {
      // Only whole web addresses: a relative one would be guessed into a host.
      const url = href && /^https?:\/\//i.test(href) ? sanitizeNavigationUrl(href) : null;
      if (!url) return <span>{children}</span>;
      return (
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault();
            openUrl(url);
          }}
          className="font-medium text-ink-accent underline underline-offset-2 hover:text-ink-accent/80"
        >
          {children}
        </a>
      );
    },
    h1: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
    h3: ({ children }) => <h4 className="mt-4 mb-2 font-semibold text-foreground first:mt-0">{children}</h4>,
    h4: ({ children }) => <h4 className="mt-4 mb-2 font-semibold text-foreground first:mt-0">{children}</h4>,
    h5: ({ children }) => <h4 className="mt-4 mb-2 font-semibold text-foreground first:mt-0">{children}</h4>,
    h6: ({ children }) => <h4 className="mt-4 mb-2 font-semibold text-foreground first:mt-0">{children}</h4>,
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground first:mt-0 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground first:mt-0 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="pl-1 [&>ol]:my-1.5 [&>p]:my-1.5 [&>ul]:my-1.5">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
    pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
    blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3">{children}</blockquote>,
    hr: () => <hr className="my-4 border-border" />,
    table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="text-left text-sm">{children}</table></div>,
    th: ({ children }) => <th className="border-b border-border px-2 py-1 font-semibold text-foreground">{children}</th>,
    td: ({ children }) => <td className="border-b border-border/50 px-2 py-1">{children}</td>,
  };
  return (
    <div className={cn('max-w-prose text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]', className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} skipHtml disallowedElements={DISALLOWED} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  );
}
