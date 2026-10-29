/** The editor's own look: what Word draws around the text, not the document's styles. */
export const EDITOR_CSS = `
.wp-doc { flex: 1; outline: none; white-space: pre-wrap; word-wrap: break-word; tab-size: 48px; -moz-tab-size: 48px; color: #000; caret-color: #000; position: relative; font-kerning: normal; }
.wp-doc p { margin: 0; min-height: 1lh; }
.wp-doc ::selection { background: rgba(0, 120, 215, 0.28); }
.wp-doc img { display: inline-block; }
.wp-doc a { color: #0563c1; text-decoration: underline; cursor: text; }
.wp-doc mark { color: inherit; padding: 0; }
.wp-doc .wp-spacer { display: block; pointer-events: none; user-select: none; }
.wp-doc .wp-spacer-inline { display: block; text-indent: 0; }
.wp-doc .wp-label { display: inline-block; text-indent: 0; font-style: normal; font-weight: inherit; text-decoration: none; user-select: none; white-space: pre; }
.wp-doc .wp-pagebreak { height: 0; position: relative; user-select: none; }
.wp-doc .wp-pagebreak span { display: none; }
.wp-marks .wp-doc .wp-pagebreak { height: 1.4em; }
.wp-marks .wp-doc .wp-pagebreak span { display: flex; align-items: center; gap: 6px; color: #5b8bd8; font: 9pt 'Inter Variable', sans-serif; }
.wp-marks .wp-doc .wp-pagebreak span::before, .wp-marks .wp-doc .wp-pagebreak span::after { content: ''; flex: 1; border-top: 1px dotted #5b8bd8; }
.wp-marks .wp-doc p::after { content: '¶'; color: #5b8bd8; font-family: 'Arimo', sans-serif; font-weight: 400; font-style: normal; text-decoration: none; }
.wp-doc .wp-pagebreak.ProseMirror-selectednode { outline: 2px solid #5b8bd8; }
.wp-doc .wp-img { position: relative; display: inline-block; line-height: 0; }
.wp-doc .wp-img img { max-width: none; }
.wp-doc .wp-img-handle { display: none; position: absolute; width: 9px; height: 9px; background: #fff; border: 1px solid #4a4a4a; border-radius: 50%; z-index: 2; }
.wp-doc .wp-img.is-selected { outline: 1px solid #4a4a4a; }
.wp-doc .wp-img.is-selected .wp-img-handle { display: block; }
.wp-img-nw { left: -5px; top: -5px; cursor: nwse-resize; } .wp-img-ne { right: -5px; top: -5px; cursor: nesw-resize; }
.wp-img-sw { left: -5px; bottom: -5px; cursor: nesw-resize; } .wp-img-se { right: -5px; bottom: -5px; cursor: nwse-resize; }
.wp-img-n { left: calc(50% - 5px); top: -5px; cursor: ns-resize; } .wp-img-s { left: calc(50% - 5px); bottom: -5px; cursor: ns-resize; }
.wp-img-e { right: -5px; top: calc(50% - 5px); cursor: ew-resize; } .wp-img-w { left: -5px; top: calc(50% - 5px); cursor: ew-resize; }
.wp-doc .tableWrapper { overflow: visible; }
.wp-doc table { border-collapse: collapse; table-layout: fixed; margin: 0; }
.wp-doc td, .wp-doc th { vertical-align: top; padding: 0 7.2px; position: relative; border: 1px dashed transparent; box-sizing: border-box; min-width: 1em; }
.wp-doc table td { border: 1px dashed #d4d4d4; }
.wp-doc table.wp-borders > tbody > tr > td { border: 1px solid #000 !important; }
.wp-doc table.wp-noborders > tbody > tr > td { border: 1px dashed #d4d4d4 !important; }
.wp-doc td.selectedCell::after { content: ''; position: absolute; inset: 0; background: rgba(0, 120, 215, 0.2); pointer-events: none; }
.wp-doc .column-resize-handle { position: absolute; right: -2px; top: 0; bottom: -2px; width: 4px; background: #5b8bd8; pointer-events: none; z-index: 3; }
.wp-doc.resize-cursor { cursor: col-resize; }
.wp-doc tr.wp-row-break > td { padding-top: var(--wp-gap); background-clip: content-box; }
.wp-doc table tr.wp-row-break > td { background-image: linear-gradient(#000, #000); background-size: 100% 1px; background-position: 0 var(--wp-gap); background-repeat: no-repeat; background-clip: border-box; }
.wp-doc .wp-find { background: #ffef9c; }
.wp-doc .wp-find-current { background: #f9a620; }
.wp-doc .wp-field { background: rgba(0, 0, 0, 0.06); }
.wp-hf .wp-field { background: none; }
.wp-doc .ProseMirror-gapcursor { display: none; position: absolute; }
.wp-doc .ProseMirror-gapcursor::after { content: ''; display: block; position: absolute; top: -2px; width: 20px; border-top: 1px solid black; animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite; }
.wp-doc.ProseMirror-focused .ProseMirror-gapcursor { display: block; }
@keyframes ProseMirror-cursor-blink { to { visibility: hidden; } }
.wp-doc .ProseMirror-hideselection *::selection { background: transparent; }
.wp-hf-editing .wp-doc { flex: 1; outline: none; }
`;
