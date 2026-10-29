import { useEffect, useMemo, useRef } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS } from '@/shared/office/accent';
import { fontStack } from '@/shared/office/fonts';
import { paragraphStyle, wordExtensions, type ParaAttrs, type WordHooks } from './schema';

/**
 * What's drawn around the text: headers and footers on every page (shown
 * dimmed, and edited in place on double-click as in Word), and the
 * Navigation pane.
 */

type Marks = NonNullable<JSONContent['marks']>;

function withMarks(node: React.ReactNode, marks: Marks | undefined, key: string | number): React.ReactNode {
  let out = node;
  for (const m of marks ?? []) {
    const a = m.attrs ?? {};
    switch (m.type) {
      case 'bold': out = <strong key={key}>{out}</strong>; break;
      case 'italic': out = <em key={key}>{out}</em>; break;
      case 'underline': out = <u key={key}>{out}</u>; break;
      case 'strike': out = <s key={key}>{out}</s>; break;
      case 'superscript': out = <sup key={key}>{out}</sup>; break;
      case 'subscript': out = <sub key={key}>{out}</sub>; break;
      case 'highlight': out = <mark key={key} style={{ backgroundColor: safeColor(a.color) }}>{out}</mark>; break;
      case 'link': out = <span key={key} className="text-[#0563c1] underline">{out}</span>; break;
      case 'textStyle':
        out = (
          <span
            key={key}
            style={{
              fontFamily: a.fontFamily ? fontStack(String(a.fontFamily)) : undefined,
              fontSize: typeof a.fontSize === 'string' && /^[\d.]+pt$/.test(a.fontSize) ? a.fontSize : undefined,
              color: safeColor(a.color),
              backgroundColor: safeColor(a.backgroundColor),
            }}
          >
            {out}
          </span>
        );
        break;
    }
  }
  return out;
}

function safeColor(c: unknown): string | undefined {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
}

function Inline({ nodes, page, pages }: { nodes: JSONContent[] | undefined; page: number; pages: number }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        switch (n.type) {
          case 'text':
            return withMarks(n.text, n.marks, i);
          case 'hardBreak':
            return <br key={i} />;
          case 'field':
            return withMarks(String(n.attrs?.kind === 'numpages' ? pages : page + 1), n.marks, i);
          case 'image': {
            const src = String(n.attrs?.src ?? '');
            return src.startsWith('blob:') ? <img key={i} src={src} alt={String(n.attrs?.alt ?? '')} style={{ width: n.attrs?.width, height: n.attrs?.height }} /> : null;
          }
          default:
            return null;
        }
      })}
    </>
  );
}

/** Header and footer content drawn without an editor. */
export function StaticBlocks({ blocks, page, pages }: { blocks: JSONContent[]; page: number; pages: number }) {
  return (
    <div className="wp-doc wp-hf">
      {blocks.map((b, i) => {
        if (b.type === 'paragraph') {
          const a = { ...DEFAULT_ATTRS, ...(b.attrs ?? {}) } as ParaAttrs;
          return (
            <p key={i} data-style={a.styleId ?? undefined} style={cssObject(paragraphStyle(a))}>
              <Inline nodes={b.content} page={page} pages={pages} />
            </p>
          );
        }
        if (b.type === 'table') {
          return (
            <table key={i} className={cn(b.attrs?.borders === true && 'wp-borders')} data-style={b.attrs?.styleId ?? undefined} style={{ width: '100%' }}>
              <tbody>
                {(b.content ?? []).map((row, r) => (
                  <tr key={r}>
                    {(row.content ?? []).map((cell, c) => (
                      <td key={c} colSpan={Number(cell.attrs?.colspan) || 1} rowSpan={Number(cell.attrs?.rowspan) || 1}>
                        <StaticBlocks blocks={cell.content ?? []} page={page} pages={pages} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return null;
      })}
    </div>
  );
}

const DEFAULT_ATTRS: ParaAttrs = {
  styleId: null, align: null, indLeft: null, indRight: null, indFirst: null, spBefore: null, spAfter: null,
  line: null, lineRule: null, numId: null, ilvl: 0, pageBreakBefore: false, shading: null, extra: null, sectPr: null,
};

function cssObject(style: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[k] = decl.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
}

/** Editing a header or footer in place. */
export function HeaderFooterEditor({
  content,
  hooks,
  page,
  onChange,
  onReady,
  onExit,
}: {
  content: JSONContent[];
  hooks: WordHooks;
  page: number;
  onChange: (content: JSONContent[]) => void;
  onReady: (editor: Editor | null) => void;
  onExit: () => void;
}) {
  const initial = useMemo(() => {
    const fill = (nodes: JSONContent[]): JSONContent[] =>
      nodes.map((n) => (n.type === 'field' ? { ...n, attrs: { ...n.attrs, text: String(page + 1) } } : n.content ? { ...n, content: fill(n.content) } : n));
    return { type: 'doc', content: content.length ? fill(content) : [{ type: 'paragraph' }] };
    // Only the content it opened with; edits flow out through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeRef = useRef(onChange);
  const exitRef = useRef(onExit);
  useEffect(() => {
    changeRef.current = onChange;
    exitRef.current = onExit;
  });
  const editor = useEditor({
    extensions: wordExtensions(hooks),
    content: initial,
    autofocus: 'end',
    editorProps: {
      attributes: { class: 'wp-doc wp-hf', spellcheck: 'false' },
      handleKeyDown: (_view, e) => {
        if (e.key === 'Escape') {
          exitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => changeRef.current(e.getJSON().content ?? []),
  });
  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);
  return <EditorContent editor={editor} />;
}

export interface Heading {
  pos: number;
  level: number;
  text: string;
}

export function NavigationPane({
  headings,
  query,
  onQuery,
  results,
  current,
  onStep,
  onHeading,
  onClose,
  inputRef,
}: {
  headings: Heading[];
  query: string;
  onQuery: (q: string) => void;
  results: { text: string; before: string; after: string }[];
  current: number;
  onStep: (dir: 1 | -1, index?: number) => void;
  onHeading: (pos: number) => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <aside aria-label="Navigation" className="flex w-[264px] shrink-0 flex-col border-r border-[#e0e0e0] bg-white select-none">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-[15px] font-semibold">Navigation</h2>
        <button type="button" aria-label="Close" onClick={onClose} className={cn('grid size-7 place-items-center rounded-[4px] hover:bg-[#f0f0f0]', FOCUS)}>
          <X className="size-4" />
        </button>
      </div>
      <div className="px-4 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-4 text-[#616161]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onStep(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Search document"
            aria-label="Search document"
            className={cn(FIELD, 'w-full pr-14 pl-8')}
          />
          {query && (
            <span className="absolute top-0.5 right-1 flex">
              <button type="button" aria-label="Previous result" onClick={() => onStep(-1)} className="grid size-6 place-items-center rounded-[3px] hover:bg-[#f0f0f0]">
                <ChevronUp className="size-3.5" />
              </button>
              <button type="button" aria-label="Next result" onClick={() => onStep(1)} className="grid size-6 place-items-center rounded-[3px] hover:bg-[#f0f0f0]">
                <ChevronDown className="size-3.5" />
              </button>
            </span>
          )}
        </div>
        {query && (
          <p role="status" className="pt-1.5 text-[12px] text-[#616161]">
            {results.length ? `Result ${Math.max(1, current + 1)} of ${results.length}` : 'No results'}
          </p>
        )}
      </div>
      <div className="border-b border-[#e0e0e0] px-4 text-[12.5px]">
        <span className="inline-block border-b-2 border-[var(--office-accent)] pb-1.5 font-semibold text-[var(--office-accent)]">{query ? 'Results' : 'Headings'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query ? (
          results.map((r, i) => (
            <button key={i} type="button" onClick={() => onStep(1, i)} className={cn('mb-1 block w-full rounded-[4px] border px-2 py-1.5 text-left text-[12.5px] hover:bg-[#f5f5f5]', i === current ? 'border-[var(--office-accent)] bg-[var(--office-accent-light)]' : 'border-[#e0e0e0]')}>
              {r.before}
              <strong>{r.text}</strong>
              {r.after}
            </button>
          ))
        ) : headings.length ? (
          headings.map((h) => (
            <button key={h.pos} type="button" onClick={() => onHeading(h.pos)} className="block w-full truncate rounded-[4px] py-1 pr-2 text-left text-[12.5px] hover:bg-[#f0f0f0]" style={{ paddingLeft: 8 + h.level * 14 }}>
              {h.text || '(empty heading)'}
            </button>
          ))
        ) : (
          <p className="px-2 py-4 text-[12.5px] leading-relaxed text-[#616161]">Create an interactive outline of your document. It’s a great way to keep track of where you are or quickly move your content around. To get started, go to the Home tab and apply Heading styles to the headings in your document.</p>
        )}
      </div>
    </aside>
  );
}
