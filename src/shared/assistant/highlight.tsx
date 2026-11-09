import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { LanguageDescription, type LanguageSupport, type TagStyle } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightTree, tagHighlighter, type Highlighter } from '@lezer/highlight';
import { DARK_SYNTAX, LIGHT_SYNTAX } from '@/shared/codeTheme';
import { useIsDark } from '@/hooks/useIsDark';

/**
 * The Code app's syntax colors, as inline styles: each spec's index stands in
 * for a class name, so nothing has to be added to the page's stylesheets.
 */
function palette(specs: TagStyle[]): { highlighter: Highlighter; styles: CSSProperties[] } {
  return {
    highlighter: tagHighlighter(specs.map(({ tag }, i) => ({ tag, class: String(i) }))),
    styles: specs.map(({ tag: _tag, ...style }) => style as CSSProperties),
  };
}

const LIGHT = palette(LIGHT_SYNTAX);
const DARK = palette(DARK_SYNTAX);

/** The language a fence names, loading its parser the first time it's needed. */
function useLanguage(name: string | undefined): LanguageSupport | undefined {
  const description = useMemo(() => (name ? LanguageDescription.matchLanguageName(languages, name, true) : null), [name]);
  const [, setLoaded] = useState(0);

  useEffect(() => {
    if (!description || description.support) return;
    let live = true;
    description.load().then(
      () => live && setLoaded((n) => n + 1),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [description]);

  return description?.support;
}

/**
 * `code` with its syntax colored, as React elements, or the plain text while
 * the language loads or when it isn't one CodeMirror knows.
 */
/** useHighlightedCode as a component, for loading this module only where there's code (see Markdown's CodeBlock). */
export function HighlightedCode({ code, language }: { code: string; language: string | undefined }) {
  return <>{useHighlightedCode(code, language)}</>;
}

function useHighlightedCode(code: string, language: string | undefined): ReactNode {
  const support = useLanguage(language);
  const dark = useIsDark();

  return useMemo(() => {
    if (!support) return code;
    const { highlighter, styles } = dark ? DARK : LIGHT;
    const tree = support.language.parser.parse(code);
    const out: ReactNode[] = [];
    let pos = 0;
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > pos) out.push(code.slice(pos, from));
      const style = Object.assign({}, ...classes.split(' ').map((i) => styles[Number(i)]));
      out.push(
        <span key={from} style={style}>
          {code.slice(from, to)}
        </span>,
      );
      pos = to;
    });
    if (pos < code.length) out.push(code.slice(pos));
    return out;
  }, [code, support, dark]);
}
