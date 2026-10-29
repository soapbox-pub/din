import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { ContextMenu as CM } from 'radix-ui';
import { BookOpenText, ClipboardPaste, Copy, FileText, Globe, Link as LinkIcon, Scissors, Type } from 'lucide-react';
import { useDin } from '@/sdk/react';
import { cn } from '@/lib/utils';
import { ACCENTS } from '@/shared/office/accent';
import {
  Backstage,
  MessageBar,
  OfficeFrame,
  Ribbon,
  RibbonTabs,
  StatusBar,
  StatusText,
  TitleBar,
  ViewButton,
  ZoomSlider,
  type BackstagePage,
  type PickedColor,
  type RibbonTab,
} from '@/shared/office/chrome';
import { stepFontSize } from '@/shared/office/fonts';
import { parseXml } from '@/shared/office/ooxml';
import { extOf, useOfficeFile } from '@/shared/office/useOfficeFile';
import {
  applyStyle,
  changeCase,
  changeIndent,
  clearFormatting,
  currentParagraph,
  currentRun,
  insertImage,
  insertTable,
  setParagraphs,
  toggleList,
  wordCount,
} from './word/commands';
import { EDITOR_CSS } from './word/css';
import {
  FontDialog,
  InsertTableDialog,
  LinkDialog,
  PageSetupDialog,
  ParagraphDialog,
  ReplaceDialog,
  WordCountDialog,
  ZoomDialog,
  type FontValues,
  type ParagraphValues,
} from './word/dialogs';
import { FindHighlight, findKey, findMatches, listKey, listLabels, pagination, relayout, type LayoutResult, type PageGeometry } from './word/layout';
import { isBulleted, levelOf, listKind } from './word/numbering';
import { Ruler } from './word/ruler';
import { AUTO_LIST_EVENT, autoFormat, type ListKind } from './word/autoformat';
import { HeaderFooterEditor, NavigationPane, StaticBlocks, type Heading } from './word/page';
import { readDocx, readText, type HFKind, type HeaderFooter, type Section, type WordDoc } from './word/read';
import { WordRibbon, type RibbonState, type WordCommands } from './word/ribbon';
import { wordExtensions, type ParaAttrs, type WordHooks } from './word/schema';
import { defaultStylesXml, effectivePara, ensureBuiltin, galleryStyles, parseStyles, styleCss } from './word/styles';
import { printHtml } from './word/print';
import { newWordDoc, TEMPLATES } from './word/templates';
import { writeDocx, writeText } from './word/write';
import { readOdt, writeOdt } from './word/odt';

const SAVE_TYPES = [
  { name: 'Word Document', patterns: ['*.docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  { name: 'OpenDocument Text', patterns: ['*.odt'], mimeTypes: ['application/vnd.oasis.opendocument.text'] },
  { name: 'Plain Text', patterns: ['*.txt'], mimeTypes: ['text/plain'] },
];
const SAVE_ODT = 1;
const SAVE_TEXT = 2;
const OPEN_EXTENSIONS = ['.docx', '.docm', '.dotx', '.odt', '.ott', '.fodt', '.txt', '.doc'];
const ODF_EXTENSIONS = new Set(['odt', 'ott', 'fodt']);
const GAP = 20;
const SETTINGS_KEY = 'din:word:settings';

const TABS: RibbonTab[] = [
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'layout', label: 'Layout' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
];

type DialogState =
  | { kind: 'font'; initial: FontValues }
  | { kind: 'paragraph'; initial: ParagraphValues }
  | { kind: 'table' }
  | { kind: 'link'; text: string; href: string; hasSelection: boolean }
  | { kind: 'replace'; find: string }
  | { kind: 'count' }
  | { kind: 'pageSetup' }
  | { kind: 'zoom' };

interface HFEdit {
  kind: 'header' | 'footer';
  type: HFKind;
  page: number;
}

interface Settings {
  zoom: number;
  collapsed: boolean;
  marks: boolean;
  spellcheck: boolean;
  ruler: boolean;
}

function readSettings(): Settings {
  const defaults: Settings = { zoom: 100, collapsed: false, marks: false, spellcheck: true, ruler: false };
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return v && typeof v === 'object' ? { ...defaults, ...(v as Partial<Settings>) } : defaults;
  } catch {
    return defaults;
  }
}

/**
 * What the editor's plugins need of each window (its page geometry and
 * document), by the window's style scope: they run outside React's render.
 */
const liveState = new Map<string, { geo: PageGeometry; doc: WordDoc }>();
function live(scope: string) {
  let entry = liveState.get(scope);
  if (!entry) {
    entry = { geo: { pageW: 816, pageH: 1056, mTop: 96, mBottom: 96, gap: GAP, paged: true }, doc: newWordDoc() };
    liveState.set(scope, entry);
  }
  return entry;
}

function viewOf(editor: Editor) {
  try {
    // Before it's mounted the view is a stand-in that throws on use.
    return editor.view.dom ? editor.view : null;
  } catch {
    return null;
  }
}

const TPL_STYLES = parseStyles(parseXml(defaultStylesXml()), newWordDoc().theme);

function hfFor(doc: WordDoc, kind: 'header' | 'footer', page: number): { type: HFKind; hf: HeaderFooter | undefined } {
  const all = kind === 'header' ? doc.headers : doc.footers;
  const type: HFKind = doc.section.titlePg && page === 0 ? 'first' : 'default';
  return { type, hf: all[type] };
}

/**
 * Word Processor - a Microsoft Word workalike: Print Layout pages, the
 * ribbon, styles, lists, tables, pictures, headers and footers, and .docx
 * files read and written so they come back from Word looking the same;
 * LibreOffice's .odt opens and saves too (see word/odt.ts).
 *
 * Opens the file it was launched with; without one it starts a blank document.
 */
export function WordProcessor() {
  const din = useDin();
  const scopeId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const scope = `wp-s-${scopeId}`;

  const [doc, setDocState] = useState<WordDoc>(() => newWordDoc());
  const docRef = useRef(doc);
  const setDoc = useCallback(
    (d: WordDoc) => {
      docRef.current = d;
      live(scope).doc = d;
      setDocState(d);
    },
    [scope],
  );
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState(readSettings);
  const { zoom, collapsed, marks, spellcheck, ruler } = settings;
  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings]);

  const [tab, setTab] = useState('home');
  const [backstage, setBackstage] = useState<BackstagePage | null>(null);
  const [web, setWeb] = useState(false);
  const [navPane, setNavPane] = useState(false);
  const [layout, setLayout] = useState<LayoutResult>({ pages: 1, pageStarts: [0] });
  const [caretPage, setCaretPage] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null);
  const [hfEdit, setHfEdit] = useState<HFEdit | null>(null);
  const [hfEditor, setHfEditor] = useState<Editor | null>(null);
  const [painter, setPainter] = useState<{ marks: JSONContent['marks']; para: Partial<ParaAttrs> } | null>(null);
  const [warningsShown, setWarningsShown] = useState(true);
  const [colors, setColors] = useState({ highlight: 'FFFF00', font: 'FF0000', shading: null as string | null, cell: null as string | null });
  const [findQuery, setFindQuery] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const navInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);

  const file = useOfficeFile({
    app: 'word',
    untitled: 'Document',
    openExtensions: OPEN_EXTENSIONS,
    saveTypes: SAVE_TYPES,
    onLoad: (bytes, path) => {
      const ext = extOf(path);
      const d = ext === 'txt' ? { ...newWordDoc(), content: readText(bytes) } : ODF_EXTENSIONS.has(ext) ? readOdt(bytes) : readDocx(bytes);
      setDoc(d);
      setWarningsShown(true);
      setHfEdit(null);
      setVersion((v) => v + 1);
    },
    onSave: (path) => {
      const content = editorRef.current?.getJSON() ?? docRef.current.content;
      const ext = extOf(path);
      if (ext === 'txt') return writeText(content);
      if (ODF_EXTENSIONS.has(ext)) return writeOdt(docRef.current, content, ext);
      return writeDocx({ doc: docRef.current, content, ext });
    },
  });
  const { setDirty } = file;

  const geometry: PageGeometry = useMemo(
    () => ({ pageW: doc.section.pageW, pageH: doc.section.pageH, mTop: doc.section.mTop, mBottom: doc.section.mBottom, gap: GAP, paged: !web }),
    [doc.section, web],
  );
  useLayoutEffect(() => {
    live(scope).geo = geometry;
    live(scope).doc = docRef.current;
  });
  useEffect(() => () => void liveState.delete(scope), [scope]);

  const hooks: WordHooks = useMemo(
    () => ({
      nextStyle: (id) => {
        const sheet = live(scope).doc.styles;
        const st = sheet.styles.get(id ?? sheet.defaultParagraph);
        if (!st?.next) return undefined;
        return st.next === sheet.defaultParagraph ? null : st.next;
      },
    }),
    [scope],
  );

  const editor = useEditor(
    {
      extensions: [
        ...wordExtensions(hooks),
        pagination({
          geometry: () => live(scope).geo,
          keepNext: (node: PMNode) => node.type.name === 'paragraph' && !!effectivePara(live(scope).doc.styles, node.attrs.styleId).keepNext,
          onLayout: setLayout,
        }),
        listLabels({
          numbering: () => live(scope).doc.numbering,
          styleNum: (id) => {
            const para = effectivePara(live(scope).doc.styles, id);
            return { numId: para.numId, ilvl: para.ilvl };
          },
        }),
        FindHighlight,
        autoFormat(),
      ],
      content: doc.content,
      editorProps: {
        attributes: { class: 'wp-doc', spellcheck: 'true' },
        handlePaste: (_view, event) => {
          const img = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
          if (!img) return false;
          void img.arrayBuffer().then((buf) => {
            const e = editorRef.current;
            if (e) void insertImage(e, new Uint8Array(buf), img.type.split('/')[1] || 'png', textWidthRef.current);
          });
          return true;
        },
        handleDrop: (_view, event) => {
          const img = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'));
          if (!img) return false;
          void img.arrayBuffer().then((buf) => {
            const e = editorRef.current;
            if (e) void insertImage(e, new Uint8Array(buf), img.type.split('/')[1] || 'png', textWidthRef.current);
          });
          return true;
        },
      },
      onUpdate: () => setDirty(true),
      shouldRerenderOnTransaction: false,
    },
    [version],
  );
  useLayoutEffect(() => {
    editorRef.current = editor;
  });

  const textWidth = doc.section.pageW - doc.section.mLeft - doc.section.mRight;
  const textWidthRef = useRef(textWidth);
  useLayoutEffect(() => {
    textWidthRef.current = textWidth;
  });

  // The editor's view exists once EditorContent has mounted it.
  const [mountedEditor, setMountedEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const on = () => setMountedEditor(editor);
    if (viewOf(editor)) queueMicrotask(on);
    else editor.on('mount', on);
    return () => {
      editor.off('mount', on);
    };
  }, [editor]);
  const mounted = mountedEditor === editor ? editor : null;

  useEffect(() => {
    mounted?.view.dom.setAttribute('spellcheck', String(spellcheck));
  }, [mounted, spellcheck]);

  // Page size, margins and view changes lay the pages out again.
  useEffect(() => {
    const view = mounted && viewOf(mounted);
    if (view) relayout(view);
  }, [mounted, geometry, zoom]);

  const active = hfEditor ?? editor;
  const sheet = doc.styles;
  const docCss = useMemo(() => styleCss(doc.styles, `.${scope} .wp-doc`), [doc.styles, scope]);

  const s: RibbonState = useEditorState({
    editor: active,
    selector: ({ editor: e }): RibbonState => {
      const d = docRef.current;
      const para = e ? currentParagraph(e) : null;
      const a = (para?.attrs ?? {}) as Partial<ParaAttrs>;
      const eff = effectivePara(d.styles, a.styleId ?? null);
      const run = e ? currentRun(e, d.styles) : { font: 'Calibri', size: 11 };
      const sel = e?.state.selection;
      const img = sel instanceof NodeSelection && sel.node.type.name === 'image' ? sel.node : null;
      const table = e?.isActive('table') ?? false;
      let tableBorders = true;
      if (table && e) {
        const { $from } = e.state.selection;
        for (let dd = $from.depth; dd > 0; dd--) {
          const t = $from.node(dd);
          if (t.type.name === 'table') tableBorders = t.attrs.borders ?? !!d.styles.styles.get(t.attrs.styleId)?.tableBorders;
        }
      }
      const numId = a.numId ?? eff.numId ?? null;
      return {
        bold: !!e?.isActive('bold'),
        italic: !!e?.isActive('italic'),
        underline: !!e?.isActive('underline'),
        strike: !!e?.isActive('strike'),
        sub: !!e?.isActive('subscript'),
        sup: !!e?.isActive('superscript'),
        font: run.font,
        size: run.size,
        align: a.align ?? eff.align ?? 'left',
        styleId: a.styleId ?? d.styles.defaultParagraph,
        listKind: numId ? listKind(d.numbering, numId) : null,
        bulleted: !!numId && isBulleted(d.numbering, numId),
        numbered: !!numId && !isBulleted(d.numbering, numId),
        line: a.line ?? (eff.lineRule === 'auto' || eff.lineRule === undefined ? (eff.line ?? 1) : null),
        inTable: table,
        imageSelected: !!img,
        imageSize: img ? { width: Number(img.attrs.width) || 0, height: Number(img.attrs.height) || 0 } : null,
        marks: false,
        web: false,
        navPane: false,
        spellcheck: false,
        painter: false,
        indLeft: Math.round(((a.indLeft ?? eff.indLeft ?? 0) / 96) * 10) / 10,
        indRight: Math.round(((a.indRight ?? eff.indRight ?? 0) / 96) * 10) / 10,
        spBefore: a.spBefore ?? eff.spBefore ?? 0,
        spAfter: a.spAfter ?? eff.spAfter ?? 0,
        titlePg: false,
        tableBorders,
        ruler: false,
        indents: (() => {
          const level = numId ? levelOf(d.numbering, numId, a.numId ? (a.ilvl ?? 0) : (eff.ilvl ?? 0)) : null;
          return {
            left: a.indLeft ?? level?.indLeft ?? eff.indLeft ?? 0,
            first: a.indFirst ?? (level ? -level.hanging : (eff.indFirst ?? 0)),
            right: a.indRight ?? eff.indRight ?? 0,
          };
        })(),
      };
    },
  }) ?? ({} as RibbonState);
  const state: RibbonState = { ...s, marks, web, navPane, spellcheck, ruler, painter: !!painter, titlePg: doc.section.titlePg };

  const history = useEditorState({
    editor: active,
    selector: ({ editor: e }) => ({ undo: !!e?.can().undo(), redo: !!e?.can().redo() }),
  }) ?? { undo: false, redo: false };

  // Which page the cursor is on, for the status bar.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const box = pagesRef.current?.getBoundingClientRect();
      if (!box || web) return setCaretPage(0);
      try {
        const c = editor.view.coordsAtPos(editor.state.selection.head);
        setCaretPage(Math.max(0, Math.floor((c.top - box.top) / (zoom / 100) / (doc.section.pageH + GAP))));
      } catch {
        // Positions can be briefly out of range while the document is replaced.
      }
    };
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor, zoom, doc.section.pageH, web]);

  // ---- Commands ------------------------------------------------------------------

  const focusEditor = useCallback(() => active?.commands.focus(), [active]);
  const markDirty = useCallback(() => setDirty(true), [setDirty]);

  const updateSection = useCallback(
    (patch: Partial<Section>) => {
      setDoc({ ...docRef.current, section: { ...docRef.current.section, ...patch } });
      markDirty();
    },
    [setDoc, markDirty],
  );

  /** Make sure a built-in style exists before using it. */
  const needStyle = useCallback(
    (id: string) => {
      const d = docRef.current;
      const styles = { ...d.styles, styles: new Map(d.styles.styles) };
      if (ensureBuiltin(styles, id)) setDoc({ ...d, styles });
      return docRef.current.styles.styles.has(id);
    },
    [setDoc],
  );

  const refreshLists = useCallback(() => {
    editor?.view.dispatch(editor.state.tr.setMeta(listKey, true));
  }, [editor]);

  const setFind = useCallback(
    (patch: { query?: string; current?: number; matchCase?: boolean; wholeWord?: boolean }) => {
      if (!editor) return;
      editor.view.dispatch(editor.state.tr.setMeta(findKey, patch));
    },
    [editor],
  );

  const goToMatch = useCallback(
    (dir: 1 | -1, index?: number) => {
      if (!editor) return;
      const f = findKey.getState(editor.state);
      if (!f || !f.matches.length) return;
      let i = index;
      if (i === undefined) {
        const head = editor.state.selection.from;
        if (dir > 0) {
          i = f.matches.findIndex((m) => m.from > head || (f.current === -1 && m.from >= head));
          if (i === -1) i = 0;
        } else {
          i = f.matches.findLastIndex((m) => m.from < head);
          if (i === -1) i = f.matches.length - 1;
        }
      }
      const m = f.matches[i];
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).setMeta(findKey, { current: i }).scrollIntoView());
    },
    [editor],
  );

  const openNav = useCallback(() => {
    setNavPane(true);
    const sel = editor?.state.selection;
    if (sel && !sel.empty && editor) {
      const text = editor.state.doc.textBetween(sel.from, sel.to);
      if (text && !text.includes('\n') && text.length < 200) {
        setFindQuery(text);
        setFind({ query: text, current: -1 });
      }
    }
    requestAnimationFrame(() => {
      navInputRef.current?.focus();
      navInputRef.current?.select();
    });
  }, [editor, setFind]);

  const applyColor = (c: PickedColor | null) => (c ? `#${c.hex}` : null);

  const commitHF = useCallback(
    (edit: HFEdit, content: JSONContent[]) => {
      const d = docRef.current;
      const key = edit.kind === 'header' ? 'headers' : 'footers';
      const prev = d[key][edit.type];
      setDoc({ ...d, [key]: { ...d[key], [edit.type]: { part: prev?.part ?? null, content, modified: true } } });
      markDirty();
    },
    [setDoc, markDirty],
  );

  const startHF = useCallback((kind: 'header' | 'footer', page = caretPage) => {
    const { type } = hfFor(docRef.current, kind, page);
    setHfEdit({ kind, type, page });
    setTab('headerFooter');
  }, [caretPage]);

  const closeHF = useCallback(() => {
    setHfEdit(null);
    setTab((t) => (t === 'headerFooter' ? 'home' : t));
    requestAnimationFrame(() => editorRef.current?.commands.focus());
  }, []);

  const setPageNumber = useCallback(
    (where: 'top' | 'bottom', align: 'left' | 'center' | 'right') => {
      const d = docRef.current;
      const kind = where === 'top' ? 'headers' : 'footers';
      const content: JSONContent[] = [{ type: 'paragraph', attrs: { align }, content: [{ type: 'field', attrs: { kind: 'page', text: '1' } }] }];
      const next = { ...d, [kind]: { ...d[kind], default: { part: d[kind].default?.part ?? null, content, modified: true } } };
      if (d.section.titlePg) next[kind].first = { part: d[kind].first?.part ?? null, content, modified: true };
      setDoc(next);
      setHfEdit(null);
      markDirty();
    },
    [setDoc, markDirty],
  );

  const pickPicture = useCallback(async () => {
    const e = active;
    if (!e) return;
    try {
      const picked = await file.pickInsert('Insert Picture', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
      if (!picked) return;
      await insertImage(e, picked.bytes, extOf(picked.name) || 'png', textWidthRef.current);
    } catch (err) {
      file.setStatus(`Couldn’t insert the picture: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [active, file]);

  const zoomTo = useCallback((z: number) => updateSettings({ zoom: Math.max(10, Math.min(500, Math.round(z))) }), [updateSettings]);
  const fitWidth = useCallback(() => {
    const w = canvasRef.current?.clientWidth ?? 800;
    zoomTo(((w - 48) / doc.section.pageW) * 100);
  }, [zoomTo, doc.section.pageW]);
  const fitPage = useCallback(() => {
    const h = canvasRef.current?.clientHeight ?? 600;
    const w = canvasRef.current?.clientWidth ?? 800;
    zoomTo(Math.min((h - 40) / doc.section.pageH, (w - 40) / doc.section.pageW) * 100);
  }, [zoomTo, doc.section.pageH, doc.section.pageW]);

  const paste = useCallback(
    async (textOnly: boolean) => {
      const e = active;
      if (!e) return;
      try {
        if (!textOnly && navigator.clipboard.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imgType = item.types.find((t) => t.startsWith('image/'));
            if (item.types.includes('text/html')) {
              const html = await (await item.getType('text/html')).text();
              e.chain().focus().insertContent(html).run();
              return;
            }
            if (imgType) {
              const buf = new Uint8Array(await (await item.getType(imgType)).arrayBuffer());
              await insertImage(e, buf, imgType.split('/')[1] || 'png', textWidthRef.current);
              return;
            }
          }
        }
        const text = await navigator.clipboard.readText();
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        e.chain()
          .focus()
          .insertContent(lines.length === 1 ? text : lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : undefined })))
          .run();
      } catch {
        file.setStatus('Use Ctrl+V to paste here.');
      }
    },
    [active, file],
  );

  const canPrint = din.permissions.has('printing') && din.print.available;
  const print = useCallback(async () => {
    const view = mounted && viewOf(mounted);
    if (!view) return;
    const d = docRef.current;
    file.setStatus('Preparing to print…');
    try {
      const html = await printHtml({
        title: file.docName,
        dom: view.dom as HTMLElement,
        docCss,
        scope,
        section: d.section,
        header: d.headers.default,
        footer: d.footers.default,
      });
      await din.print.html(file.docName, html);
      file.setStatus(null);
    } catch (err) {
      file.setStatus(`Couldn’t print: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [din, mounted, file, scope, docCss]);

  const cmd: WordCommands = {
    paste: (t) => void paste(t),
    cut: () => {
      focusEditor();
      document.execCommand('cut');
    },
    copy: () => {
      focusEditor();
      document.execCommand('copy');
    },
    formatPainter: () => {
      if (painter || !active) return setPainter(null);
      const para = currentParagraph(active);
      const a = (para?.attrs ?? {}) as ParaAttrs;
      setPainter({
        marks: active.state.selection.$from.marks().map((m) => m.toJSON() as NonNullable<JSONContent['marks']>[number]),
        para: { styleId: a.styleId, align: a.align, line: a.line, lineRule: a.lineRule, spBefore: a.spBefore, spAfter: a.spAfter },
      });
    },
    font: (name) => active?.chain().focus().setFontFamily(name).run(),
    size: (pt) => active?.chain().focus().setFontSize(`${pt}pt`).run(),
    grow: (dir) => {
      if (!active) return;
      const cur = currentRun(active, sheet).size;
      active.chain().focus().setFontSize(`${stepFontSize(cur, dir)}pt`).run();
    },
    changeCase: (m) => active && changeCase(active, m),
    clearFormatting: () => active && clearFormatting(active),
    toggle: (mark) => {
      const c = active?.chain().focus();
      if (!c) return;
      ({ bold: () => c.toggleBold(), italic: () => c.toggleItalic(), underline: () => c.toggleUnderline(), strike: () => c.toggleStrike(), subscript: () => c.toggleSubscript(), superscript: () => c.toggleSuperscript() })[mark]().run();
    },
    highlight: (c) => {
      if (c) setColors((x) => ({ ...x, highlight: c.hex }));
      if (c) active?.chain().focus().setHighlight({ color: `#${c.hex}` }).run();
      else active?.chain().focus().unsetHighlight().run();
    },
    fontColor: (c) => {
      if (c) setColors((x) => ({ ...x, font: c.hex }));
      const col = applyColor(c);
      if (col) active?.chain().focus().setColor(col).run();
      else active?.chain().focus().unsetColor().run();
    },
    bullets: (kind, force) => {
      if (!active) return;
      toggleList(active, docRef.current.numbering, { bullet: kind }, force, needStyle('ListParagraph'));
      refreshLists();
    },
    numbering: (kind, force) => {
      if (!active) return;
      toggleList(active, docRef.current.numbering, { number: kind }, force, needStyle('ListParagraph'));
      refreshLists();
    },
    indent: (dir) => active && changeIndent(active, dir, sheet),
    toggleMarks: () => updateSettings({ marks: !marks }),
    align: (a) => active && setParagraphs(active, { align: a }),
    lineSpacing: (n) => active && setParagraphs(active, { line: n, lineRule: 'auto' }),
    spaceBefore: (add) => active && setParagraphs(active, { spBefore: add ? 12 : 0 }),
    spaceAfter: (add) => active && setParagraphs(active, { spAfter: add ? 12 : 0 }),
    shading: (c) => {
      if (c) setColors((x) => ({ ...x, shading: c.hex }));
      if (active) setParagraphs(active, { shading: c?.hex ?? null });
    },
    style: (st) => active && applyStyle(active, st),
    find: openNav,
    replace: () => setDialog({ kind: 'replace', find: findQuery }),
    selectAll: () => active?.chain().focus().selectAll().run(),
    paragraphDialog: () => openParagraphDialog(),
    fontDialog: () => openFontDialog(),
    pageBreak: () => editor?.chain().focus().insertContent({ type: 'pageBreak' }).run(),
    blankPage: () => editor?.chain().focus().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }, { type: 'pageBreak' }]).run(),
    table: (cols, rows) => {
      if (!editor) return;
      needStyle('TableGrid');
      insertTable(editor, cols, rows, textWidthRef.current);
    },
    tableDialog: () => setDialog({ kind: 'table' }),
    picture: () => void pickPicture(),
    link: () => openLinkDialog(),
    editHeaderFooter: (k) => startHF(k),
    removeHeaderFooter: (k) => {
      const d = docRef.current;
      setDoc({ ...d, [k === 'header' ? 'headers' : 'footers']: {} });
      setHfEdit(null);
      markDirty();
    },
    pageNumber: setPageNumber,
    removePageNumbers: () => {
      const d = docRef.current;
      const strip = (all: WordDoc['headers']) =>
        Object.fromEntries(
          Object.entries(all).map(([k, h]) => {
            const drop = (nodes: JSONContent[]): JSONContent[] => nodes.filter((n) => n.type !== 'field').map((n) => (n.content ? { ...n, content: drop(n.content) } : n));
            return [k, { ...h!, content: drop(h!.content), modified: true }];
          }),
        );
      setDoc({ ...d, headers: strip(d.headers), footers: strip(d.footers) });
      markDirty();
    },
    dateTime: () => active?.chain().focus().insertContent(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })).run(),
    symbol: (ch) => active?.chain().focus().insertContent(ch).run(),
    margins: (m) => updateSection({ mTop: m.top * 96, mBottom: m.bottom * 96, mLeft: m.left * 96, mRight: m.right * 96 }),
    pageSetup: () => setDialog({ kind: 'pageSetup' }),
    orientation: (landscape) => {
      const { pageW, pageH } = docRef.current.section;
      if (landscape === pageW > pageH) return;
      updateSection({ pageW: pageH, pageH: pageW });
    },
    paperSize: (w, h) => {
      const landscape = docRef.current.section.pageW > docRef.current.section.pageH;
      updateSection(landscape ? { pageW: h * 96, pageH: w * 96 } : { pageW: w * 96, pageH: h * 96 });
    },
    setIndent: (side, inches) => active && setParagraphs(active, side === 'left' ? { indLeft: inches * 96 } : { indRight: inches * 96 }),
    setSpacing: (side, pt) => active && setParagraphs(active, side === 'before' ? { spBefore: pt } : { spAfter: pt }),
    spelling: () => updateSettings({ spellcheck: !spellcheck }),
    wordCount: () => setDialog({ kind: 'count' }),
    web: (on) => setWeb(on),
    navPane: () => (navPane ? setNavPane(false) : openNav()),
    ruler: () => updateSettings({ ruler: !ruler }),
    zoomDialog: () => setDialog({ kind: 'zoom' }),
    zoom: zoomTo,
    onePage: fitPage,
    pageWidth: fitWidth,
    tableShading: (c) => {
      if (c) setColors((x) => ({ ...x, cell: c.hex }));
      active?.chain().focus().setCellAttribute('background', c?.hex ?? null).run();
    },
    tableBorders: (on) => {
      if (!active) return;
      const { $from } = active.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
          active.view.dispatch(active.state.tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, borders: on }));
          break;
        }
      }
    },
    tableInsert: (w) => {
      const c = active?.chain().focus();
      if (!c) return;
      ({ above: () => c.addRowBefore(), below: () => c.addRowAfter(), left: () => c.addColumnBefore(), right: () => c.addColumnAfter() })[w]().run();
    },
    tableDelete: (w) => {
      const c = active?.chain().focus();
      if (!c) return;
      ({ rows: () => c.deleteRow(), columns: () => c.deleteColumn(), table: () => c.deleteTable() })[w]().run();
    },
    mergeCells: () => active?.chain().focus().mergeCells().run(),
    splitCell: () => active?.chain().focus().splitCell().run(),
    cellAlign: (v) => active?.chain().focus().setCellAttribute('valign', v === 'top' ? null : v).run(),
    imageSize: (w, h) => {
      if (!active) return;
      const sel = active.state.selection;
      if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return;
      const a = sel.node.attrs;
      const ratio = (Number(a.height) || 1) / (Number(a.width) || 1);
      const width = w ?? (h !== null ? h / ratio : Number(a.width));
      const height = h ?? width * ratio;
      active.view.dispatch(active.state.tr.setNodeMarkup(sel.from, undefined, { ...a, width: Math.round(width), height: Math.round(height) }).setSelection(NodeSelection.create(active.state.doc, sel.from)));
    },
    resetImage: () => {
      if (!active) return;
      const sel = active.state.selection;
      if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return;
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, textWidthRef.current / Math.max(1, img.naturalWidth));
        active.view.dispatch(active.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) }));
      };
      img.src = String(sel.node.attrs.src);
    },
    differentFirstPage: (on) => updateSection({ titlePg: on }),
    hfDistance: (k, inches) => updateSection(k === 'header' ? { mHeader: inches * 96 } : { mFooter: inches * 96 }),
    closeHeaderFooter: closeHF,
  };

  // "* " and "1. " typed at the start of a paragraph start lists.
  const autoList = useRef<(kind: ListKind) => void>(() => {});
  useLayoutEffect(() => {
    autoList.current = (kind) => ('bullet' in kind ? cmd.bullets(kind.bullet, true) : cmd.numbering(kind.number, true));
  });
  useEffect(() => {
    const dom = mounted && viewOf(mounted)?.dom;
    if (!dom) return;
    const on = (e: Event) => autoList.current((e as CustomEvent<ListKind>).detail);
    dom.addEventListener(AUTO_LIST_EVENT, on);
    return () => dom.removeEventListener(AUTO_LIST_EVENT, on);
  }, [mounted]);

  function openFontDialog() {
    if (!active) return;
    const run = currentRun(active, sheet);
    const color = active.getAttributes('textStyle').color as string | undefined;
    setDialog({
      kind: 'font',
      initial: {
        font: run.font,
        size: run.size,
        bold: active.isActive('bold'),
        italic: active.isActive('italic'),
        underline: active.isActive('underline'),
        strike: active.isActive('strike'),
        superscript: active.isActive('superscript'),
        subscript: active.isActive('subscript'),
        color: color ? color.replace('#', '').toUpperCase() : null,
      },
    });
  }

  function openParagraphDialog() {
    if (!active) return;
    const para = currentParagraph(active);
    const a = (para?.attrs ?? {}) as Partial<ParaAttrs>;
    const eff = effectivePara(sheet, a.styleId ?? null);
    const first = a.indFirst ?? eff.indFirst ?? 0;
    const rule = a.lineRule ?? eff.lineRule ?? 'auto';
    const line = a.line ?? eff.line ?? 1;
    const mode: ParagraphValues['lineMode'] =
      rule === 'exact' ? 'exactly' : rule === 'atLeast' ? 'atLeast' : Math.abs(line - 1) < 0.01 ? 'single' : Math.abs(line - 1.5) < 0.01 ? '1.5' : Math.abs(line - 2) < 0.01 ? 'double' : 'multiple';
    setDialog({
      kind: 'paragraph',
      initial: {
        align: (a.align ?? eff.align ?? 'left') as ParagraphValues['align'],
        indLeft: Math.round(((a.indLeft ?? eff.indLeft ?? 0) / 96) * 100) / 100,
        indRight: Math.round(((a.indRight ?? eff.indRight ?? 0) / 96) * 100) / 100,
        special: first > 0 ? 'firstLine' : first < 0 ? 'hanging' : 'none',
        by: Math.round((Math.abs(first) / 96) * 100) / 100,
        spBefore: a.spBefore ?? eff.spBefore ?? 0,
        spAfter: a.spAfter ?? eff.spAfter ?? 0,
        lineMode: mode,
        lineAt: line,
      },
    });
  }

  function openLinkDialog() {
    if (!active) return;
    const { from, to, empty } = active.state.selection;
    const href = (active.getAttributes('link').href as string | undefined) ?? '';
    setDialog({ kind: 'link', text: active.state.doc.textBetween(from, to), href, hasSelection: !empty });
  }

  // Format painter: the next selection made with the mouse takes the formatting.
  useEffect(() => {
    if (!painter || !mounted) return;
    const editor = mounted;
    const dom = editor.view.dom as HTMLElement;
    const up = () =>
      requestAnimationFrame(() => {
        if (editor.state.selection.empty) return;
        const c = editor.chain().focus().unsetAllMarks();
        for (const m of painter.marks ?? []) c.setMark(m.type, m.attrs ?? {});
        c.run();
        setParagraphs(editor, painter.para);
        setPainter(null);
      });
    dom.addEventListener('mouseup', up);
    return () => dom.removeEventListener('mouseup', up);
  }, [painter, mounted]);

  // ---- Keyboard ------------------------------------------------------------------

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (dialog || backstage) return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    let handled = true;
    const ed = active;
    if (ctrl && !alt && key === 's' && !shift) void file.save();
    else if ((ctrl && shift && key === 's') || e.key === 'F12') void file.saveAs();
    else if (ctrl && !shift && key === 'o') setBackstage('open');
    else if (ctrl && !shift && key === 'n') file.newWindow();
    else if (ctrl && !shift && key === 'w') file.requestClose();
    else if (ctrl && !shift && key === 'p' && canPrint) void print();
    else if (ctrl && !shift && key === 'f') openNav();
    else if (ctrl && !shift && key === 'h') setDialog({ kind: 'replace', find: findQuery });
    else if (ctrl && !shift && key === 'k') openLinkDialog();
    else if (ctrl && !shift && key === 'd') openFontDialog();
    else if (ctrl && !shift && !alt && key === 'e' && ed) setParagraphs(ed, { align: state.align === 'center' ? 'left' : 'center' });
    else if (ctrl && !shift && !alt && key === 'l' && ed) setParagraphs(ed, { align: 'left' });
    else if (ctrl && !shift && !alt && key === 'r' && ed) setParagraphs(ed, { align: state.align === 'right' ? 'left' : 'right' });
    else if (ctrl && !shift && !alt && key === 'j' && ed) setParagraphs(ed, { align: state.align === 'justify' ? 'left' : 'justify' });
    else if (ctrl && !shift && !alt && ['1', '2', '5'].includes(e.key) && ed) setParagraphs(ed, { line: e.key === '1' ? 1 : e.key === '2' ? 2 : 1.5, lineRule: 'auto' });
    else if (ctrl && alt && ['1', '2', '3'].includes(e.key) && ed) {
      needStyle(`Heading${e.key}`);
      const st = docRef.current.styles.styles.get(`Heading${e.key}`);
      if (st) applyStyle(ed, st);
    } else if (ctrl && shift && key === 'n' && ed) setParagraphs(ed, { styleId: null });
    else if (ctrl && shift && key === 'l') cmd.bullets('disc');
    else if (ctrl && !shift && e.key === ']') cmd.size(state.size + 1);
    else if (ctrl && !shift && e.key === '[') cmd.size(Math.max(1, state.size - 1));
    else if (ctrl && shift && (e.key === '>' || e.key === '.')) cmd.grow(1);
    else if (ctrl && shift && (e.key === '<' || e.key === ',')) cmd.grow(-1);
    else if (ctrl && !shift && e.key === '=') cmd.toggle('subscript');
    else if (ctrl && shift && (e.key === '+' || e.key === '=')) cmd.toggle('superscript');
    else if (ctrl && !shift && key === 'm') cmd.indent(1);
    else if (ctrl && shift && key === 'm') cmd.indent(-1);
    else if (ctrl && !shift && e.key === ' ') ed?.chain().focus().unsetAllMarks().run();
    else if (ctrl && !shift && key === 'q' && ed) setParagraphs(ed, { align: null, indLeft: null, indRight: null, indFirst: null, spBefore: null, spAfter: null, line: null, lineRule: null });
    else if (ctrl && shift && key === 'c') cmd.formatPainter();
    else if (ctrl && shift && key === 'v') void paste(true);
    else if (ctrl && shift && e.key === '*') cmd.toggleMarks();
    else if (shift && e.key === 'F3' && ed) {
      const { from, to } = ed.state.selection;
      const text = ed.state.doc.textBetween(from, to);
      changeCase(ed, text === text.toUpperCase() ? 'lower' : text === text.toLowerCase() ? 'title' : 'upper');
    } else if (ctrl && e.key === 'F1') updateSettings({ collapsed: !collapsed });
    else if (e.key === 'Escape' && hfEdit) closeHF();
    else if (e.key === 'Escape' && painter) setPainter(null);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---- Derived -------------------------------------------------------------------

  const tplCss = useMemo(() => styleCss(TPL_STYLES, '.wp-tpl .wp-doc'), []);
  const gallery = useMemo(() => galleryStyles(doc.styles), [doc.styles]);

  const stats = useMemo(() => (dialog?.kind === 'count' && editor ? wordCount(editor.state.doc) : null), [dialog, editor]);
  const [words, setWords] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let t = 0;
    const update = () => {
      clearTimeout(t);
      t = window.setTimeout(() => setWords(wordCount(editor.state.doc).words), 250);
    };
    update();
    editor.on('update', update);
    return () => {
      clearTimeout(t);
      editor.off('update', update);
    };
  }, [editor]);

  const headings = useEditorState({
    editor,
    selector: ({ editor: e }): Heading[] => {
      if (!e || !navPane) return [];
      const out: Heading[] = [];
      e.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return node.type.name !== 'table';
        const lvl = effectivePara(docRef.current.styles, node.attrs.styleId).outlineLvl;
        if (lvl !== undefined && lvl < 9) out.push({ pos, level: lvl, text: node.textContent.slice(0, 80) });
        return false;
      });
      return out;
    },
  }) ?? [];

  const find = useEditorState({ editor, selector: ({ editor: e }) => (e ? findKey.getState(e.state) : null) }) ?? null;
  const results = useMemo(() => {
    if (!find || !editor || !find.query) return [];
    return find.matches.slice(0, 200).map((m) => {
      const $from = editor.state.doc.resolve(m.from);
      const start = $from.start();
      const end = $from.end();
      return {
        before: (m.from - start > 30 ? '…' : '') + editor.state.doc.textBetween(Math.max(start, m.from - 30), m.from),
        text: editor.state.doc.textBetween(m.from, m.to),
        after: editor.state.doc.textBetween(m.to, Math.min(end, m.to + 40)) + (end - m.to > 40 ? '…' : ''),
      };
    });
  }, [find, editor]);

  const contextual: RibbonTab[] = [];
  if (hfEdit) contextual.push({ id: 'headerFooter', label: 'Header & Footer', contextual: true });
  if (state.inTable) contextual.push({ id: 'tableDesign', label: 'Table Design', contextual: true }, { id: 'tableLayout', label: 'Layout', contextual: true });
  if (state.imageSelected) contextual.push({ id: 'picture', label: 'Picture Format', contextual: true });
  const tabs = [...TABS, ...contextual];
  const shownTab = tabs.some((t) => t.id === tab) ? tab : 'home';

  // ---- Render --------------------------------------------------------------------

  const { section } = doc;
  const pages = web ? 1 : layout.pages;
  const totalH = pages * (section.pageH + GAP) - GAP;
  const saveStatus = file.saving ? 'Saving…' : file.status?.startsWith('Couldn’t') ? file.status : file.dirty ? '' : file.handle ? 'Saved' : '';


  const hfLayer = (i: number) => {
    const render = (kind: 'header' | 'footer') => {
      const { hf, type } = hfFor(doc, kind, i);
      const editing = hfEdit && hfEdit.kind === kind && hfEdit.page === i;
      const style: React.CSSProperties =
        kind === 'header' ? { top: section.mHeader, left: section.mLeft, right: section.mRight } : { bottom: section.mFooter, left: section.mLeft, right: section.mRight };
      if (editing) {
        return (
          <div key={kind} className="pointer-events-auto absolute z-20" style={style} onDoubleClick={(e) => e.stopPropagation()}>
            <HeaderFooterEditor
              key={`${kind}${type}${i}${version}`}
              content={hf?.content ?? []}
              hooks={hooks}
              page={i}
              onChange={(c) => commitHF(hfEdit, c)}
              onReady={setHfEditor}
              onExit={closeHF}
            />
          </div>
        );
      }
      if (!hf?.content.length) return null;
      return (
        <div key={kind} className={cn('pointer-events-none absolute', !hfEdit && 'opacity-55')} style={style}>
          <StaticBlocks blocks={hf.content} page={i} pages={pages} />
        </div>
      );
    };
    return (
      <>
        {render('header')}
        {render('footer')}
        {hfEdit && hfEdit.page === i && (
          <>
            <div className="pointer-events-none absolute inset-x-0 border-b border-dashed border-[#5b8bd8]" style={{ top: section.mTop - 4 }}>
              <span className="absolute left-0 top-full rounded-br-[3px] bg-[#e5e5e5] px-2 py-0.5 text-[10px] text-[#424242]" style={{ fontFamily: "'Inter Variable', sans-serif" }}>
                {hfEdit.type === 'first' ? 'First Page Header' : 'Header'}
              </span>
            </div>
            <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[#5b8bd8]" style={{ top: section.pageH - section.mBottom + 4 }}>
              <span className="absolute bottom-full left-0 rounded-tr-[3px] bg-[#e5e5e5] px-2 py-0.5 text-[10px] text-[#424242]" style={{ fontFamily: "'Inter Variable', sans-serif" }}>
                {hfEdit.type === 'first' ? 'First Page Footer' : 'Footer'}
              </span>
            </div>
          </>
        )}
      </>
    );
  };

  const onPagesDoubleClick = (e: React.MouseEvent) => {
    if (web) return;
    const box = pagesRef.current?.getBoundingClientRect();
    if (!box) return;
    const y = (e.clientY - box.top) / (zoom / 100);
    const page = Math.floor(y / (section.pageH + GAP));
    const inPage = y - page * (section.pageH + GAP);
    if (inPage < section.mTop) startHF('header', page);
    else if (inPage > section.pageH - section.mBottom) startHF('footer', page);
    else if (hfEdit) closeHF();
  };

  return (
    <OfficeFrame
      app="word"
      onKeyDownCapture={onKeyDownCapture}
      onFocus={(e) => {
        // Focus that lands on the window itself goes on to the document.
        if (e.target === e.currentTarget && !backstage && !dialog) active?.commands.focus();
      }}
    >
      <style>{EDITOR_CSS}</style>
      <style>{docCss}</style>
      <style>{tplCss}</style>
      <TitleBar
        title={`${file.docName} - ${ACCENTS.word.name}`}
        status={saveStatus}
        onSave={() => void file.save()}
        onUndo={() => active?.chain().focus().undo().run()}
        onRedo={() => active?.chain().focus().redo().run()}
        canUndo={history.undo}
        canRedo={history.redo}
        search={{
          placeholder: 'Search',
          onSearch: (q) => {
            setNavPane(true);
            setFindQuery(q);
            setFind({ query: q, current: -1 });
          },
        }}
      />
      <RibbonTabs tabs={tabs} active={shownTab} onSelect={setTab} onFile={() => setBackstage('home')} collapsed={collapsed} onToggleCollapsed={() => updateSettings({ collapsed: !collapsed })} />
      <Ribbon collapsed={collapsed}>
        <WordRibbon
          tab={shownTab}
          s={state}
          cmd={cmd}
          theme={doc.theme}
          gallery={gallery}
          section={section}
          lastHighlight={colors.highlight}
          lastFontColor={colors.font}
          lastShading={colors.shading}
          lastCellShading={colors.cell}
        />
      </Ribbon>
      {warningsShown && doc.warnings.length > 0 && (
        <MessageBar tone="warning" onDismiss={() => setWarningsShown(false)}>
          {doc.warnings.join(' ')}
        </MessageBar>
      )}

      <div className="flex min-h-0 flex-1 border-t border-[#e0e0e0]">
        {navPane && (
          <NavigationPane
            headings={headings}
            query={findQuery}
            onQuery={(q) => {
              setFindQuery(q);
              setFind({ query: q, current: -1 });
            }}
            results={results}
            current={find?.current ?? -1}
            onStep={goToMatch}
            onHeading={(pos) => {
              editor?.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
            }}
            onClose={() => {
              setNavPane(false);
              setFindQuery('');
              setFind({ query: '', current: -1 });
              editor?.commands.focus();
            }}
            inputRef={navInputRef}
          />
        )}
        <CM.Root modal={false}>
          <CM.Trigger asChild>
            <div
              ref={canvasRef}
              className={cn('relative min-w-0 flex-1 overflow-auto select-text', web ? 'bg-white' : 'bg-[#e6e6e6]', marks && 'wp-marks', painter && '[&_.wp-doc]:cursor-copy')}
              onWheel={(e) => {
                if (!e.ctrlKey) return;
                e.preventDefault();
                zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
              }}
            >
              {web ? (
                <div className={cn(scope, 'flex min-h-full flex-col px-10 py-6')} style={{ zoom: zoom / 100 }}>
                  <EditorContent editor={editor} className="flex flex-1 flex-col" />
                </div>
              ) : (
                <div className="pb-5" style={{ width: Math.max(section.pageW * (zoom / 100) + 48, 0), margin: '0 auto' }}>
                  {ruler ? (
                    <div className="sticky top-0 z-30 mb-3 flex justify-center bg-[#e6e6e6] pt-1.5 pb-1">
                      <Ruler
                        pageW={section.pageW}
                        mLeft={section.mLeft}
                        mRight={section.mRight}
                        zoom={zoom}
                        indents={state.indents}
                        onChange={(i, done) => done && active && setParagraphs(active, { indLeft: i.left, indFirst: i.first, indRight: i.right })}
                      />
                    </div>
                  ) : (
                    <div className="h-5" />
                  )}
                  <div style={{ width: section.pageW * (zoom / 100), height: totalH * (zoom / 100), margin: '0 auto', position: 'relative' }}>
                    <div
                      ref={pagesRef}
                      className={scope}
                      onDoubleClick={onPagesDoubleClick}
                      style={{ width: section.pageW, height: totalH, transform: `scale(${zoom / 100})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}
                    >
                      {Array.from({ length: pages }, (_, i) => (
                        <div
                          key={i}
                          className="absolute bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_6px_rgba(0,0,0,0.14)]"
                          style={{ top: i * (section.pageH + GAP), left: 0, width: section.pageW, height: section.pageH }}
                        />
                      ))}
                      <div
                        className={cn('relative z-10 transition-opacity motion-reduce:transition-none', hfEdit && 'opacity-45')}
                        style={{ paddingTop: section.mTop, paddingLeft: section.mLeft, paddingRight: section.mRight, minHeight: totalH }}
                      >
                        <EditorContent editor={editor} className="flex flex-col" style={{ minHeight: totalH - section.mTop - section.mBottom }} />
                      </div>
                      {/* The margins and the gaps between pages sit above the text, so nothing runs across from one page to the next. */}
                      <div className="pointer-events-none absolute inset-0 z-20">
                        {Array.from({ length: pages - 1 }, (_, i) => (
                          <div
                            key={`g${i}`}
                            className="absolute bg-[linear-gradient(to_bottom,rgba(0,0,0,0.13),#e6e6e6_4px,#e6e6e6_calc(100%-2px),rgba(0,0,0,0.06))]"
                            style={{ top: i * (section.pageH + GAP) + section.pageH, height: GAP, left: 0, right: 0 }}
                          />
                        ))}
                        {Array.from({ length: pages }, (_, i) => (
                          <div key={i} className="absolute" style={{ top: i * (section.pageH + GAP), left: 0, width: section.pageW, height: section.pageH }}>
                            <div className="absolute inset-x-0 top-0 bg-white" style={{ height: section.mTop }} />
                            <div className="absolute inset-x-0 bottom-0 bg-white" style={{ height: section.mBottom }} />
                            {hfLayer(i)}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {(file.loading || file.error) && (
                <div className="absolute inset-0 z-30 grid place-items-center bg-[#e6e6e6] p-6 text-center">
                  {file.loading ? (
                    <div className="h-[70%] w-[min(600px,80%)] animate-pulse rounded-sm bg-white shadow motion-reduce:animate-none" />
                  ) : (
                    <div className="max-w-md space-y-1 rounded-lg bg-white p-6 shadow">
                      <p className="text-[15px] font-semibold">We couldn’t open {file.name}</p>
                      <p className="text-[13px] text-[#616161]">{file.error}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CM.Trigger>
          <DocContextMenu cmd={cmd} inTable={state.inTable} />
        </CM.Root>
      </div>

      <StatusBar>
        <StatusText>
          Page {Math.min(caretPage + 1, pages)} of {pages}
        </StatusText>
        <StatusText onClick={() => setDialog({ kind: 'count' })} title="Word Count">
          {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        </StatusText>
        <StatusText className="hidden md:inline">English (United States)</StatusText>
        <span className="flex-1" />
        <ViewButton label="Print Layout" active={!web} onClick={() => setWeb(false)}>
          <BookOpenText />
        </ViewButton>
        <ViewButton label="Web Layout" active={web} onClick={() => setWeb(true)}>
          <Globe />
        </ViewButton>
        <ZoomSlider zoom={zoom} onZoom={zoomTo} onDialog={() => setDialog({ kind: 'zoom' })} />
      </StatusBar>

      {dialog?.kind === 'font' && (
        <FontDialog
          initial={dialog.initial}
          onCancel={() => setDialog(null)}
          onOk={(v) => {
            setDialog(null);
            const c = active?.chain().focus();
            if (!c) return;
            c.setFontFamily(v.font).setFontSize(`${v.size}pt`);
            if (v.bold) c.setBold();
            else c.unsetBold();
            if (v.italic) c.setItalic();
            else c.unsetItalic();
            if (v.underline) c.setUnderline();
            else c.unsetUnderline();
            if (v.strike) c.setStrike();
            else c.unsetStrike();
            if (v.superscript) c.setSuperscript();
            else c.unsetSuperscript();
            if (v.subscript) c.setSubscript();
            else c.unsetSubscript();
            if (v.color) c.setColor(`#${v.color}`);
            else c.unsetColor();
            c.run();
          }}
        />
      )}
      {dialog?.kind === 'paragraph' && (
        <ParagraphDialog
          initial={dialog.initial}
          onCancel={() => setDialog(null)}
          onOk={(v) => {
            setDialog(null);
            if (!active) return;
            const multiple = v.lineMode === 'single' ? 1 : v.lineMode === '1.5' ? 1.5 : v.lineMode === 'double' ? 2 : v.lineAt;
            setParagraphs(active, {
              align: v.align,
              indLeft: v.indLeft * 96,
              indRight: v.indRight * 96,
              indFirst: v.special === 'none' ? 0 : (v.special === 'hanging' ? -1 : 1) * v.by * 96,
              spBefore: v.spBefore,
              spAfter: v.spAfter,
              line: multiple,
              lineRule: v.lineMode === 'exactly' ? 'exact' : v.lineMode === 'atLeast' ? 'atLeast' : 'auto',
            });
          }}
        />
      )}
      {dialog?.kind === 'table' && (
        <InsertTableDialog
          onCancel={() => setDialog(null)}
          onOk={(c, r) => {
            setDialog(null);
            cmd.table(c, r);
          }}
        />
      )}
      {dialog?.kind === 'link' && (
        <LinkDialog
          initialText={dialog.text}
          initialHref={dialog.href}
          hasSelection={dialog.hasSelection}
          onCancel={() => setDialog(null)}
          onRemove={dialog.href ? () => (setDialog(null), active?.chain().focus().extendMarkRange('link').unsetLink().run()) : undefined}
          onOk={(text, href) => {
            setDialog(null);
            if (!active) return;
            if (dialog.hasSelection || dialog.href) active.chain().focus().extendMarkRange('link').setLink({ href }).run();
            else active.chain().focus().insertContent({ type: 'text', text: text || href, marks: [{ type: 'link', attrs: { href } }] }).run();
          }}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ReplaceDialog
          initialFind={dialog.find}
          message={replaceMsg}
          onCancel={() => {
            setDialog(null);
            setReplaceMsg(null);
            editor?.commands.focus();
          }}
          onFind={(q, mc, ww) => {
            if (!editor) return;
            const matches = findMatches(editor.state.doc, q, mc, ww);
            if (!matches.length) return setReplaceMsg('We couldn’t find what you were looking for.');
            const head = editor.state.selection.to;
            const m = matches.find((x) => x.from >= head) ?? matches[0];
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).scrollIntoView());
            setReplaceMsg(null);
          }}
          onReplace={(q, r, mc, ww) => {
            if (!editor) return;
            const { from, to } = editor.state.selection;
            const sel = editor.state.doc.textBetween(from, to);
            if (sel && (mc ? sel === q : sel.toLowerCase() === q.toLowerCase())) editor.chain().insertContentAt({ from, to }, r).run();
            const matches = findMatches(editor.state.doc, q, mc, ww);
            const head = editor.state.selection.to;
            const m = matches.find((x) => x.from >= head) ?? matches[0];
            if (m) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).scrollIntoView());
            else setReplaceMsg('All done. There are no more matches.');
          }}
          onReplaceAll={(q, r, mc, ww) => {
            if (!editor) return;
            const matches = findMatches(editor.state.doc, q, mc, ww);
            const tr = editor.state.tr;
            for (const m of [...matches].reverse()) {
              const marks = editor.state.doc.resolve(m.from + 1).marks();
              if (r) tr.replaceWith(m.from, m.to, editor.state.schema.text(r, marks));
              else tr.delete(m.from, m.to);
            }
            editor.view.dispatch(tr);
            setReplaceMsg(`All done. We made ${matches.length} replacement${matches.length === 1 ? '' : 's'}.`);
          }}
        />
      )}
      {dialog?.kind === 'count' && stats && <WordCountDialog stats={{ ...stats, pages }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'pageSetup' && (
        <PageSetupDialog
          section={section}
          onCancel={() => setDialog(null)}
          onOk={(sec) => {
            setDialog(null);
            updateSection(sec);
          }}
        />
      )}
      {dialog?.kind === 'zoom' && (
        <ZoomDialog
          zoom={zoom}
          onCancel={() => setDialog(null)}
          onOk={(z) => {
            setDialog(null);
            zoomTo(z);
          }}
          onPageWidth={() => {
            setDialog(null);
            fitWidth();
          }}
          onWholePage={() => {
            setDialog(null);
            fitPage();
          }}
        />
      )}

      {file.prompt}
      {backstage && (
        <Backstage
          page={backstage}
          onPage={setBackstage}
          onClose={() => {
            setBackstage(null);
            requestAnimationFrame(() => editor?.commands.focus());
          }}
          onSave={() => {
            setBackstage(null);
            void file.save();
          }}
          onCloseDocument={() => {
            setBackstage(null);
            file.requestClose();
          }}
          templates={TEMPLATES.map((t) => ({
            id: t.id,
            name: t.name,
            preview: <TemplatePreview build={t.build} />,
            create: () => {
              setBackstage(null);
              const fresh = editor && !file.dirty && !file.handle && editor.state.doc.textContent === '' && !file.error;
              if (fresh) {
                setDoc(newWordDoc(t.build));
                setVersion((v) => v + 1);
                if (t.id !== 'blank') setDirty(true);
              } else file.newWindow();
            },
          }))}
          recent={file.recent}
          onOpenRecent={(r) => {
            setBackstage(null);
            void file.openRecent(r);
          }}
          onBrowse={() => {
            setBackstage(null);
            void file.browse();
          }}
          onSaveAs={() => {
            setBackstage(null);
            void file.saveAs();
          }}
          onShowRecentInFiles={(r) => void file.showRecentInFiles(r)}
          path={file.handle?.path ?? null}
          onPrint={
            canPrint
              ? () => {
                  setBackstage(null);
                  void print();
                }
              : undefined
          }
          info={
            <div className="max-w-lg space-y-2 text-[13px]">
              <p>
                <span className="text-[#616161]">Location: </span>
                {file.handle?.path ?? 'Not saved yet'}
              </p>
              <p>
                <span className="text-[#616161]">Pages: </span>
                {pages}
              </p>
              <p>
                <span className="text-[#616161]">Words: </span>
                {words.toLocaleString()}
              </p>
              <p>
                <span className="text-[#616161]">Page size: </span>
                {(section.pageW / 96).toFixed(2)}" × {(section.pageH / 96).toFixed(2)}"
              </p>
            </div>
          }
          exports={[
            {
              label: 'OpenDocument Text',
              description: 'Save a copy as an .odt file for LibreOffice Writer and other OpenDocument apps.',
              icon: <FileText />,
              onClick: () => {
                setBackstage(null);
                void file.exportCopy(SAVE_ODT);
              },
            },
            {
              label: 'Plain Text',
              description: 'Save just the words, without formatting, as a .txt file.',
              icon: <FileText />,
              onClick: () => {
                setBackstage(null);
                void file.exportCopy(SAVE_TEXT);
              },
            },
          ]}
        />
      )}
    </OfficeFrame>
  );
}

function TemplatePreview({ build }: { build: (n: ReturnType<typeof newWordDoc>['numbering']) => JSONContent[] }) {
  const blocks = useMemo(() => build(newWordDoc().numbering), [build]);
  return (
    <span className="wp-tpl relative block h-[194px] w-[150px] overflow-hidden bg-white">
      <span className="absolute top-0 left-0 block origin-top-left" style={{ width: 816, padding: '72px 96px', transform: 'scale(0.1838)' }}>
        <StaticBlocks blocks={blocks} page={0} pages={1} />
      </span>
    </span>
  );
}

function DocContextMenu({ cmd, inTable }: { cmd: WordCommands; inTable: boolean }) {
  const item = 'flex h-8 cursor-default items-center gap-2.5 rounded-[4px] px-2 pr-6 outline-none data-[highlighted]:bg-[#f0f0f0] data-[disabled]:text-[#bdbdbd]';
  const icon = 'grid w-5 place-items-center text-[#424242] [&>svg]:size-4';
  return (
    <CM.Portal>
      <CM.Content
        className="z-[60] min-w-52 rounded-md border border-[#d1d1d1] bg-white p-1 text-[12.5px] text-[#242424] shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
        style={{ fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <CM.Item className={item} onSelect={cmd.cut}>
          <span className={icon}><Scissors /></span>Cut
        </CM.Item>
        <CM.Item className={item} onSelect={cmd.copy}>
          <span className={icon}><Copy /></span>Copy
        </CM.Item>
        <CM.Item className={item} onSelect={() => cmd.paste(false)}>
          <span className={icon}><ClipboardPaste /></span>Paste
        </CM.Item>
        <CM.Item className={item} onSelect={() => cmd.paste(true)}>
          <span className={icon}><Type /></span>Paste as Text Only
        </CM.Item>
        <CM.Separator className="mx-1 my-1 h-px bg-[#e0e0e0]" />
        <CM.Item className={item} onSelect={cmd.fontDialog}>
          <span className={icon}><span className="text-[13px] font-semibold">A</span></span>Font…
        </CM.Item>
        <CM.Item className={item} onSelect={cmd.paragraphDialog}>
          <span className={icon}><span className="text-[13px]">¶</span></span>Paragraph…
        </CM.Item>
        <CM.Separator className="mx-1 my-1 h-px bg-[#e0e0e0]" />
        <CM.Item className={item} onSelect={cmd.link}>
          <span className={icon}><LinkIcon /></span>Link
        </CM.Item>
        {inTable && (
          <>
            <CM.Separator className="mx-1 my-1 h-px bg-[#e0e0e0]" />
            <CM.Item className={item} onSelect={() => cmd.tableInsert('above')}>
              <span className={icon} />Insert Rows Above
            </CM.Item>
            <CM.Item className={item} onSelect={() => cmd.tableInsert('below')}>
              <span className={icon} />Insert Rows Below
            </CM.Item>
            <CM.Item className={item} onSelect={() => cmd.tableInsert('left')}>
              <span className={icon} />Insert Columns to the Left
            </CM.Item>
            <CM.Item className={item} onSelect={() => cmd.tableInsert('right')}>
              <span className={icon} />Insert Columns to the Right
            </CM.Item>
            <CM.Item className={item} onSelect={() => cmd.tableDelete('rows')}>
              <span className={icon} />Delete Rows
            </CM.Item>
            <CM.Item className={item} onSelect={() => cmd.tableDelete('columns')}>
              <span className={icon} />Delete Columns
            </CM.Item>
            <CM.Item className={item} onSelect={cmd.mergeCells}>
              <span className={icon} />Merge Cells
            </CM.Item>
          </>
        )}
      </CM.Content>
    </CM.Portal>
  );
}

