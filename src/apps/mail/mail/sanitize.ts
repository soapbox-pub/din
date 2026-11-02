/**
 * An HTML email made safe to show. The message goes into an iframe with
 * `sandbox="allow-same-origin"` (no scripts, forms, pop-ups or top-level
 * navigation; the same origin only so Mail can size it and catch its link
 * clicks), with a CSP of its own on top of Mail's. This strips what the
 * sandbox would refuse anyway, plus anything that would load or navigate
 * by itself, and holds remote pictures and styles back unless the user
 * asked for them, since loading them tells the sender the mail was read.
 */

const REMOVE = 'script, noscript, iframe, frame, frameset, object, embed, applet, base, meta, portal, template';
const REMOTE = /^(https?:)?\/\//i;

export interface PreparedHtml {
  html: string;
  /** Whether anything was held back that "Load Remote Content" would bring in. */
  hasRemote: boolean;
}

export function prepareHtml(source: string, allowRemote: boolean): PreparedHtml {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  let hasRemote = false;

  doc.querySelectorAll(REMOVE).forEach((el) => el.remove());
  doc.querySelectorAll('link').forEach((el) => {
    const stylesheet = /\bstylesheet\b/i.test(el.getAttribute('rel') ?? '');
    if (!stylesheet) el.remove();
    else if (REMOTE.test(el.getAttribute('href') ?? '')) hasRemote = true;
  });

  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc' || name === 'ping') {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href' || name === 'background' || name === 'poster') && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        el.removeAttribute(attr.name);
      } else if ((name === 'src' || name === 'srcset' || name === 'background' || name === 'poster') && REMOTE.test(value)) {
        hasRemote = true;
      } else if (name === 'style' && /url\(\s*['"]?\s*(https?:)?\/\//i.test(value)) {
        hasRemote = true;
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('rel', 'noopener noreferrer');
      el.removeAttribute('target');
    }
  }
  doc.querySelectorAll('style').forEach((el) => {
    if (/url\(\s*['"]?\s*(https?:)?\/\/|@import/i.test(el.textContent ?? '')) hasRemote = true;
  });
  if (!allowRemote) holdBackPictures(doc);

  const remote = allowRemote ? ' https: http:' : '';
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', `default-src 'none'; img-src data: blob:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src data:${remote}`);
  const base = doc.createElement('style');
  base.textContent = BASE_CSS;
  doc.head.prepend(base);
  doc.head.prepend(csp);
  return { html: `<!DOCTYPE html>${doc.documentElement.outerHTML}`, hasRemote };
}

function isRemotePicture(el: Element): boolean {
  const src = el.getAttribute('src')?.trim() ?? '';
  if (src && !REMOTE.test(src)) return false;
  return REMOTE.test(src) || (el.getAttribute('srcset') ?? '').split(',').some((s) => REMOTE.test(s.trim()));
}

function pixels(v: string | null): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(v ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Remote pictures, held back, as quiet placeholders the size the message
 * gave them instead of broken images: tracking pixels go, a picture with
 * no size shows its alt text, or nothing when it has none.
 */
function holdBackPictures(doc: Document): void {
  doc.querySelectorAll('picture > source').forEach((el) => {
    if (isRemotePicture(el)) el.remove();
  });
  for (const img of doc.querySelectorAll('img')) {
    if (!isRemotePicture(img)) continue;
    const style = img.getAttribute('style') ?? '';
    const cssSize = (prop: string) => new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style)?.[2].trim() ?? null;
    const width = img.getAttribute('width') ?? cssSize('width');
    const height = img.getAttribute('height') ?? cssSize('height');
    const w = pixels(width);
    const h = pixels(height);
    const alt = (img.getAttribute('alt') ?? '').trim();
    if ((w !== null && w <= 3) || (h !== null && h <= 3) || /display\s*:\s*none/i.test(style) || (!width && !height && !alt)) {
      img.remove();
      continue;
    }
    const sized = !!(width || height);
    const box = doc.createElement('span');
    box.className = sized ? 'din-held-back din-held-back-sized' : 'din-held-back';
    if (/display\s*:\s*block/i.test(style)) box.classList.add('din-held-back-block');
    box.setAttribute('role', 'img');
    if (alt) {
      box.setAttribute('aria-label', alt);
      box.setAttribute('title', alt);
      if (sized) {
        // Shown when the box has room for it.
        const label = doc.createElement('span');
        label.className = 'din-held-back-alt';
        label.textContent = alt;
        box.append(label);
      } else {
        box.textContent = alt;
      }
    }
    const size: string[] = [];
    if (width) size.push(`width: ${w !== null ? `${w}px` : width}`);
    if (w !== null && h !== null) size.push(`aspect-ratio: ${w} / ${h}`);
    else if (height) size.push(`height: ${h !== null ? `${h}px` : height}`);
    const own = style.replace(/(^|;)\s*(width|height|display)\s*:[^;]*/gi, '');
    box.setAttribute('style', `${size.join('; ')}${size.length ? ';' : ''}${own}`);
    img.replaceWith(box);
  }
}

const PICTURE_ICON = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>')}")`;

/** Mail's defaults under the message's own styles. */
const BASE_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 20px 24px 32px; font: 14px/1.5 "Inter Variable", -apple-system, "Segoe UI", sans-serif; color: #1d1d1f; background: #fff; overflow-wrap: break-word; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
blockquote[type="cite"], .gmail_quote > blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid #0a84ff; color: #3a3a3c; }
a { color: #0a63d1; }
.din-held-back { display: inline-block; box-sizing: border-box; max-width: 100%; overflow: hidden; vertical-align: middle; padding: 4px 8px 4px 28px; border-radius: 6px; background: #f4f4f5 ${PICTURE_ICON} no-repeat 6px center / 16px; color: #71717a; font: 12px/16px "Inter Variable", -apple-system, "Segoe UI", sans-serif; text-align: left; white-space: nowrap; text-overflow: ellipsis; text-decoration: none; }
.din-held-back-sized { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 24px; padding: 0 8px; background-image: none; container-type: size; white-space: nowrap; text-align: center; }
.din-held-back-sized::before { content: ""; flex: none; width: 24px; height: 24px; max-height: 60%; background: ${PICTURE_ICON} no-repeat center / contain; }
.din-held-back-block { display: flex; }
.din-held-back-alt { display: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
@container (min-width: 96px) and (min-height: 64px) { .din-held-back-alt { display: block; } }
a .din-held-back { cursor: pointer; }
`;
