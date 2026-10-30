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

/** Mail's defaults under the message's own styles. */
const BASE_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 20px 24px 32px; font: 14px/1.5 "Inter Variable", -apple-system, "Segoe UI", sans-serif; color: #1d1d1f; background: #fff; overflow-wrap: break-word; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
blockquote[type="cite"], .gmail_quote > blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid #0a84ff; color: #3a3a3c; }
a { color: #0a63d1; }
`;
