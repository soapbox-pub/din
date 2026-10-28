import { memo, useContext, useRef, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { CopyButton } from '@/components/desktop/assistant/CopyButton';
import { FileLinkBaseContext, filePathOfHref } from '@/components/desktop/assistant/fileLinks';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { appForFile } from '@/lib/fileTypes';
import { cleanFsError, getFsBridge, parentPath } from '@/lib/fs';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm];

// The default drops `file:` links; they are opened as files, never loaded.
const urlTransform = (url: string) => (/^file:/i.test(url) ? url : defaultUrlTransform(url));

/**
 * The agent's replies, as Markdown. react-markdown builds React elements and
 * leaves raw HTML out, so nothing the model writes reaches the DOM as
 * markup; links open through Din's router, and only http(s) ones. Links to
 * files open them in Din's apps, relative to the conversation's folder.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const openUrl = useOpenUrl();
  const base = useContext(FileLinkBaseContext);

  const components: Components = {
    a: ({ href, children }) => {
      const file = href ? filePathOfHref(href, base) : null;
      if (file) return <FileLink path={file}>{children}</FileLink>;
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
    pre: ({ node, children }) => {
      const code = node?.children[0];
      const classes = code?.type === 'element' ? code.properties.className : undefined;
      const language = Array.isArray(classes)
        ? classes.map(String).find((name) => name.startsWith('language-'))?.slice('language-'.length)
        : undefined;
      return <CodeBlock language={language}>{children}</CodeBlock>;
    },
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
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground first:mt-0 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground first:mt-0 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="pl-1 [&>ol]:my-1.5 [&>p]:my-1.5 [&>ul]:my-1.5">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    h1: ({ children }) => <h3 className="mb-3 mt-6 text-xl font-semibold first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="mb-3 mt-6 text-lg font-semibold first:mt-0">{children}</h3>,
    h3: ({ children }) => <h4 className="mb-2 mt-5 font-semibold first:mt-0">{children}</h4>,
    h4: ({ children }) => <h4 className="mb-2 mt-4 font-semibold first:mt-0">{children}</h4>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
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
      if (file) return <FileLink path={file}>{alt || file.slice(file.lastIndexOf('/') + 1)}</FileLink>;
      const url = typeof src === 'string' ? sanitizeNavigationUrl(src) : null;
      return url ? (
        <a href={url} onClick={(e) => { e.preventDefault(); openUrl(url); }} className="text-primary underline">
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
function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const { open } = useWindowActions();
  const { toast } = useToast();
  const fs = getFsBridge();
  if (!fs) return <span className="underline decoration-dotted" title={path}>{children}</span>;

  const name = path.slice(path.lastIndexOf('/') + 1);
  const openFile = () => {
    fs.stat(path).then(
      ({ kind }) => open(kind === 'directory' ? 'file-browser' : appForFile(name), { path }),
      (error: unknown) => toast({ title: `Couldn’t open ${name}`, description: cleanFsError(error), variant: 'destructive' }),
    );
  };
  const showInFolder = () => open('file-browser', { path: parentPath(path), select: name });

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
          className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {children}
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openFile}>
          <SquareArrowOutUpRight aria-hidden /> Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={showInFolder}>
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

/** A fenced block with its language and a copy button above it. */
function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border/60 bg-muted/50 first:mt-0 last:mb-0">
      <div className="flex items-center justify-between border-b border-border/60 py-1 pl-4 pr-1.5">
        <span className="font-mono text-xs text-muted-foreground">{language}</span>
        <CopyButton text={() => ref.current?.textContent ?? ''} label="Copy code" showLabel />
      </div>
      <pre ref={ref} className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
    </div>
  );
}
