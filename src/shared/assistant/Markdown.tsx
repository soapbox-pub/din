import { lazy, memo, Suspense, useContext, useRef, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { CopyButton } from '@/shared/assistant/CopyButton';
import { FileLinkBaseContext, filePathOfHref } from '@/shared/assistant/fileLinks';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cleanFsError, getFsBridge } from '@/lib/fs';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { useAssistantHost } from '@/shared/assistant/host';

const REMARK_PLUGINS = [remarkGfm];

// The default drops `file:` links; they are opened as files, never loaded.
const urlTransform = (url: string) => (/^file:/i.test(url) ? url : defaultUrlTransform(url));

/**
 * The agent's replies, as Markdown. react-markdown builds React elements and
 * leaves raw HTML out, so nothing the model writes reaches the DOM as
 * markup; links open through Din's router, and only http(s) ones. Links to
 * files open them in Din's apps, relative to the conversation's folder.
 * Unless turned off in Settings, headings, emphasis, code and links each get
 * their own color, and list markers share bold text's, as in OpenCode's
 * terminal UI.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const { openUrl, colorfulReplies: c } = useAssistantHost();
  const base = useContext(FileLinkBaseContext);
  const link = cn(
    'font-medium underline underline-offset-2',
    c ? 'text-md-link hover:text-md-link/80' : 'text-primary hover:text-primary/80',
  );
  const marker = c ? 'marker:text-md-strong' : 'marker:text-muted-foreground';
  const heading = c && 'text-md-heading';

  const components: Components = {
    a: ({ href, children }) => {
      const file = href ? filePathOfHref(href, base) : null;
      if (file) return <FileLink path={file} className={link}>{children}</FileLink>;
      const url = href ? sanitizeNavigationUrl(href) : null;
      if (!url) return <span className="underline decoration-dotted">{children}</span>;
      return (
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault();
            openUrl(url);
          }}
          className={link}
        >
          {children}
        </a>
      );
    },
    pre: ({ node }) => {
      const code = node?.children[0];
      const classes = code?.type === 'element' ? code.properties.className : undefined;
      const language = Array.isArray(classes)
        ? classes.map(String).find((name) => name.startsWith('language-'))?.slice('language-'.length)
        : undefined;
      const text = code?.type === 'element' ? code.children.map((c) => (c.type === 'text' ? c.value : '')).join('') : '';
      return <CodeBlock language={language} code={text.replace(/\n$/, '')} />;
    },
    // Inline only: fenced blocks are drawn by `pre`, from the text itself.
    code: ({ className: _language, children, ...props }: ComponentProps<'code'>) => (
      <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', c && 'text-md-code')} {...props}>
        {children}
      </code>
    ),
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className={cn('my-3 list-disc space-y-1.5 pl-6 first:mt-0 last:mb-0', marker)}>{children}</ul>,
    ol: ({ children }) => <ol className={cn('my-3 list-decimal space-y-1.5 pl-6 first:mt-0 last:mb-0', marker)}>{children}</ol>,
    li: ({ children }) => <li className="pl-1 [&>ol]:my-1.5 [&>p]:my-1.5 [&>ul]:my-1.5">{children}</li>,
    strong: ({ children }) => <strong className={cn('font-semibold', c && 'text-md-strong')}>{children}</strong>,
    em: ({ children }) => <em className={cn('italic', c && 'text-md-emph')}>{children}</em>,
    h1: ({ children }) => <h3 className={cn('mb-3 mt-6 text-xl font-semibold first:mt-0', heading)}>{children}</h3>,
    h2: ({ children }) => <h3 className={cn('mb-3 mt-6 text-lg font-semibold first:mt-0', heading)}>{children}</h3>,
    h3: ({ children }) => <h4 className={cn('mb-2 mt-5 font-semibold first:mt-0', heading)}>{children}</h4>,
    h4: ({ children }) => <h4 className={cn('mb-2 mt-4 font-semibold first:mt-0', heading)}>{children}</h4>,
    blockquote: ({ children }) => (
      <blockquote className={cn('my-3 border-l-2 pl-4 text-muted-foreground', c ? 'border-md-quote' : 'border-border')}>{children}</blockquote>
    ),
    hr: () => <hr className="my-6 border-border/60" />,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border border-border/60 px-2 py-1 align-top">{children}</td>,
    // Pictures the model names could be anything, from anywhere: a link instead.
    img: ({ src, alt }) => {
      const file = typeof src === 'string' ? filePathOfHref(src, base) : null;
      if (file) return <FileLink path={file} className={link}>{alt || file.slice(file.lastIndexOf('/') + 1)}</FileLink>;
      const url = typeof src === 'string' ? sanitizeNavigationUrl(src) : null;
      return url ? (
        <a href={url} onClick={(e) => { e.preventDefault(); openUrl(url); }} className={link}>
          {alt || url}
        </a>
      ) : null;
    },
  };

  return (
    <div className={cn('break-words leading-7', className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} urlTransform={urlTransform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A link to a file on this computer: clicking opens it in the app Files would
 * use (a folder opens in Files), and right-clicking can show it in its folder.
 */
function FileLink({ path, className, children }: { path: string; className: string; children: ReactNode }) {
  const { openPath, showInFolder, notify } = useAssistantHost();
  const fs = getFsBridge();
  if (!fs) return <span className="underline decoration-dotted" title={path}>{children}</span>;

  const name = path.slice(path.lastIndexOf('/') + 1);
  const openFile = () => {
    fs.stat(path).then(
      ({ kind }) => openPath(path, kind === 'directory' ? 'directory' : 'file'),
      (error: unknown) => notify({ title: `Couldn’t open ${name}`, description: cleanFsError(error), destructive: true }),
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a
          href={`file://${encodeURI(path)}`}
          title={path}
          onClick={(event) => {
            event.preventDefault();
            openFile();
          }}
          className={className}
        >
          {children}
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openFile}>
          <SquareArrowOutUpRight aria-hidden /> Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => showInFolder(path)}>
          <FolderOpen aria-hidden /> Show in Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(path).catch(() => {})}>
          <Copy aria-hidden /> Copy Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Syntax coloring, with CodeMirror's language support (some 300 KB), loaded
 * with the first code block shown: until then, and in a window with none,
 * code is plain.
 */
const HighlightedCode = lazy(() => import('@/shared/assistant/highlight').then((m) => ({ default: m.HighlightedCode })));

/** A fenced block, its syntax colored, with its language and a copy button above it. */
function CodeBlock({ language, code }: { language?: string; code: string }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="my-4 overflow-hidden rounded-xl bg-muted/60 first:mt-0 last:mb-0">
      <div className="flex items-center justify-between py-1 pl-4 pr-1.5">
        <span className="font-mono text-xs text-muted-foreground">{language}</span>
        <CopyButton text={() => ref.current?.textContent ?? ''} label="Copy code" showLabel />
      </div>
      <pre ref={ref} className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <code>
          <Suspense fallback={code}>
            <HighlightedCode code={code} language={language} />
          </Suspense>
        </code>
      </pre>
    </div>
  );
}
