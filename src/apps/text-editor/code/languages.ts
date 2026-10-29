import { LanguageDescription, LanguageSupport, StreamLanguage, type StringStream } from '@codemirror/language';
import { languages as known } from '@codemirror/language-data';

interface NixState {
  /** What each open `${` (or `{` inside one) returns to: a string's kind, or null for code. */
  stack: ('"' | "''" | null)[];
  inString: '"' | "''" | null;
  inComment: boolean;
}

const NIX_KEYWORDS = /^(?:let|in|with|rec|inherit|if|then|else|assert|or)\b/;
const NIX_BUILTINS = /^(?:import|builtins|true|false|null|throw|abort|map|toString|derivation|baseNameOf|dirOf|isNull|removeAttrs)\b/;

function nixString(stream: StringStream, state: NixState): string {
  const quote = state.inString!;
  while (!stream.eol()) {
    if (stream.match('${', false)) {
      if (stream.pos === stream.start) {
        stream.next();
        stream.next();
        state.stack.push(quote);
        state.inString = null;
        return 'meta';
      }
      return 'string';
    }
    if (quote === '"') {
      if (stream.eat('\\')) {
        stream.next();
        continue;
      }
      if (stream.eat('"')) {
        state.inString = null;
        return 'string';
      }
    } else {
      // In '' strings, ''$ ''' and ''\x escape; '' ends.
      if (stream.match("''$") || stream.match("'''") || stream.match(/^''\\./)) continue;
      if (stream.match("''")) {
        state.inString = null;
        return 'string';
      }
    }
    stream.next();
  }
  return 'string';
}

/** Nix, which language-data has no mode for: DinOS is configured in it. */
const nix = StreamLanguage.define<NixState>({
  name: 'nix',
  startState: () => ({ stack: [], inString: null, inComment: false }),
  copyState: (s) => ({ stack: [...s.stack], inString: s.inString, inComment: s.inComment }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.inComment = false;
      } else {
        stream.skipToEnd();
      }
      return 'comment';
    }
    if (state.inString) return nixString(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inComment = true;
      return 'comment';
    }
    if (stream.match('"')) {
      state.inString = '"';
      return 'string';
    }
    if (stream.match("''")) {
      state.inString = "''";
      return 'string';
    }
    if (stream.match('${') || stream.match('{')) {
      state.stack.push(null);
      return stream.current() === '${' ? 'meta' : 'bracket';
    }
    if (stream.eat('}')) {
      if (state.stack.length > 0) {
        const back = state.stack.pop()!;
        if (back) {
          state.inString = back;
          return 'meta';
        }
      }
      return 'bracket';
    }
    if (stream.match(/^(?:\.{0,2}|~)(?:\/[\w.+-]+)+\/?/) || stream.match(/^<[\w.+/-]+>/)) return 'string.special';
    if (stream.match(/^[a-z][a-z0-9+.-]*:\/\/[^\s;]+/i)) return 'link';
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number';
    if (stream.match(NIX_KEYWORDS)) return 'keyword';
    if (stream.match(NIX_BUILTINS)) return 'atom';
    if (stream.match(/^[A-Za-z_][\w'-]*/)) {
      return /^\s*(?:\.[\w"'-]+)*\s*=(?!=)/.test(stream.string.slice(stream.pos)) ? 'propertyName' : 'variableName';
    }
    if (stream.match(/^(?:==|!=|<=|>=|&&|\|\||->|\/\/|\+\+|[-+*/<>!?@=:;,.])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#', block: { open: '/*', close: '*/' } } },
});

const extra: LanguageDescription[] = [
  LanguageDescription.of({ name: 'Nix', extensions: ['nix'], support: new LanguageSupport(nix) }),
];

/** Every language the editor can highlight, by name. */
export const languages: readonly LanguageDescription[] = [...known, ...extra].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** Names that don't say what they are by extension alone. */
const ALIASES: [RegExp, string][] = [
  [/^\.?(?:bash|zsh|ksh)(?:rc|_profile|_logout|env)$|^\.profile$|\.(?:zsh|bash)$|^\.envrc$/, 'Shell'],
  [/^\.env(?:\..*)?$|\.(?:conf|cfg|desktop|service|timer|socket|mount|editorconfig)$|^\.(?:editorconfig|npmrc|gitconfig)$/, 'Properties files'],
  [/\.(?:jsonc|json5)$|^\.(?:eslintrc|babelrc|prettierrc)$|^tsconfig.*\.json$/, 'JSON'],
  [/^\.gitignore$|^\.dockerignore$/, 'Shell'],
  [/^Containerfile$|\.dockerfile$/, 'Dockerfile'],
];

/** The language a file name suggests, if any. */
export function languageFor(name: string): LanguageDescription | null {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const byName = LanguageDescription.matchFilename(languages, base);
  if (byName) return byName;
  for (const [pattern, language] of ALIASES) {
    if (pattern.test(base)) return languages.find((l) => l.name === language) ?? null;
  }
  return null;
}

/** The language a `#!` line asks for (scripts without an extension). */
export function languageForShebang(firstLine: string): LanguageDescription | null {
  const match = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\S+)/.exec(firstLine);
  if (!match) return null;
  const program = match[1].replace(/[\d.]+$/, '');
  const name: Record<string, string> = {
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', dash: 'Shell', ksh: 'Shell',
    python: 'Python', node: 'JavaScript', deno: 'TypeScript', bun: 'TypeScript',
    ruby: 'Ruby', perl: 'Perl', lua: 'Lua', php: 'PHP', nix: 'Nix', 'nix-shell': 'Shell',
  };
  const wanted = name[program];
  return wanted ? (languages.find((l) => l.name === wanted) ?? null) : null;
}
