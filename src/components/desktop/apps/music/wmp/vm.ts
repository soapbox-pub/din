/**
 * The runtime that runs one Windows Media Player skin view's JScript, inside
 * the sandboxed iframe of public/wmp-sandbox.html.
 *
 * It holds the view's object model - every element with its attributes,
 * `player`, `theme`, `view`, `mediacenter` - and keeps it in step with the
 * host: attribute changes go out as patches the host renders, player calls
 * go out as calls the host performs, and the host sends back the player's
 * state and the user's clicks and drags. `wmpprop:` bindings re-evaluate
 * whenever a property they read changes.
 *
 * Everything lives inside one function, which the host turns into source
 * text (Function.prototype.toString) and sends to the iframe: it must not
 * refer to anything outside itself. Types are erased, so the protocol types
 * are only imported as types.
 */
import type { HostToVm, PlayerSnapshot, VmInit, VmNode, VmToHost } from './protocol';

export function wmpVmRuntime(): void {
  type Fn = (...args: unknown[]) => unknown;
  type Obj = Record<string, unknown>;

  interface El {
    iid: string;
    tag: string;
    otag: string;
    id: string | null;
    attrs: Obj;
    handlers: Record<string, string>;
    parent: El | null;
    children: El[];
    proxy: Obj;
    compiled: Record<string, Fn>;
    special?: { has(name: string): boolean; get(name: string): unknown; set(name: string, value: unknown): boolean };
    methods: Record<string, Fn>;
  }

  interface Binding {
    el: El;
    attr: string;
    fn: () => unknown;
    deps: Set<string>;
  }

  const post = (msg: VmToHost) => parent.postMessage(msg, '*');
  const report = (where: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'error', message: `${where}: ${message}` });
  };

  let snap = {} as PlayerSnapshot;
  let init = {} as VmInit;
  const elements = new Map<string, El>();
  const byId = new Map<string, El>();
  let root: El | null = null;
  let currentEvent: Obj | null = null;
  const exported = new Map<string, [() => unknown, (v: unknown) => void]>();

  // ---- patches to the host ----------------------------------------------

  let patch: Record<string, Obj> = {};
  let patchQueued = false;
  const queuePatch = (iid: string, name: string, value: unknown) => {
    (patch[iid] ??= {})[name] = typeof value === 'function' ? undefined : value;
    if (!patchQueued) {
      patchQueued = true;
      queueMicrotask(() => {
        patchQueued = false;
        const out = patch;
        patch = {};
        try {
          post({ type: 'patch', patch: out });
        } catch {
          post({ type: 'patch', patch: JSON.parse(JSON.stringify(out)) as Record<string, Obj> });
        }
      });
    }
  };
  const call = (target: string, method: string, args: unknown[] = [], iid?: string) => post({ type: 'call', target, method, args, iid });

  // ---- reactivity --------------------------------------------------------

  let collector: Set<string> | null = null;
  const subs = new Map<string, Set<Binding>>();
  const running = new Set<Binding>();
  const track = (key: string) => collector?.add(key);
  const notify = (key: string) => {
    const set = subs.get(key);
    if (!set) return;
    for (const b of [...set]) runBinding(b);
  };
  function runBinding(b: Binding) {
    if (running.has(b) || running.size > 64) return;
    running.add(b);
    for (const d of b.deps) subs.get(d)?.delete(b);
    const prev = collector;
    collector = new Set();
    let value: unknown;
    try {
      value = b.fn();
    } catch {
      value = undefined;
    }
    b.deps = collector;
    collector = prev;
    for (const d of b.deps) {
      let set = subs.get(d);
      if (!set) subs.set(d, (set = new Set()));
      set.add(b);
    }
    if (value !== undefined) setAttr(b.el, b.attr, value, 'binding');
    running.delete(b);
  }

  // ---- values ------------------------------------------------------------

  const NUMERIC = /^(left|top|width|height|right|bottom|zindex|alphablend|min|max|value|fontsize|scrollingamount|scrollingdelay|timerinterval|bordersize|foregroundprogress|currentpreset|hueshift|saturation|backgroundimagehueshift|backgroundimagesaturation|selecteditem|minwidth|minheight|maxwidth|maxheight|gainlevel\d+|splinetension|crossfadewindow|trubasslevel|wowlevel|speakersize|brightness|contrast|hue|textlimit|zoom)$/;
  const coerce = (el: El, name: string, raw: string): unknown => {
    if (/^true$/i.test(raw.trim())) return true;
    if (/^false$/i.test(raw.trim())) return false;
    if (name === 'value' && (el.tag === 'text' || el.tag === 'editbox')) return raw;
    if (NUMERIC.test(name) && /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(raw)) return Number(raw);
    return raw;
  };
  const truthy = (v: unknown) => v === true || v === 'true' || (typeof v === 'number' && v !== 0);
  const two = (n: number) => String(n).padStart(2, '0');
  const timeString = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    return h > 0 ? `${two(h)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
  };
  const S = <K extends keyof PlayerSnapshot>(field: K): PlayerSnapshot[K] => {
    track(`snap.${field}`);
    return snap[field];
  };

  /** A case-insensitive observable object for the player's object model. */
  function model(props: Record<string, { get?: () => unknown; set?: (v: unknown) => void }>, methods: Record<string, Fn> = {}): Obj {
    const lower: Record<string, { get?: () => unknown; set?: (v: unknown) => void }> = {};
    for (const [k, v] of Object.entries(props)) lower[k.toLowerCase()] = v;
    const fns: Record<string, Fn> = {};
    for (const [k, v] of Object.entries(methods)) fns[k.toLowerCase()] = v;
    return new Proxy({} as Obj, {
      has: (_, p) => typeof p === 'string' && (p.toLowerCase() in lower || p.toLowerCase() in fns),
      get: (_, p) => {
        if (typeof p !== 'string') return undefined;
        const k = p.toLowerCase();
        if (k in fns) return fns[k];
        return lower[k]?.get?.();
      },
      set: (_, p, v) => {
        if (typeof p === 'string') lower[p.toLowerCase()]?.set?.(v);
        return true;
      },
    });
  }

  // ---- the player --------------------------------------------------------

  const local: Obj = {};
  const itemInfo = (item: { name: string; artist: string; album: string; duration: number } | undefined, attr: string): string => {
    if (!item) return '';
    switch (attr.toLowerCase()) {
      case 'title': case 'name': return item.name;
      case 'author': case 'artist': case 'wm/albumartist': return item.artist;
      case 'wm/albumtitle': case 'album': return item.album;
      case 'duration': return String(item.duration);
      default: return '';
    }
  };
  function media(index: () => number): Obj {
    const item = () => {
      const i = index();
      return i === S('current') ? { name: S('name'), artist: S('artist'), album: S('album'), duration: S('duration') } : S('items')[i];
    };
    return model(
      {
        name: { get: () => item()?.name ?? '' },
        duration: { get: () => item()?.duration ?? 0 },
        durationString: { get: () => timeString(item()?.duration ?? 0) },
        sourceURL: { get: () => (index() === S('current') ? S('url') : (item()?.name ?? '')) },
        attributeCount: { get: () => 4 },
        // Skins tell video from audio by whether the picture has a size.
        imageSourceWidth: { get: () => (index() === S('current') && S('isVideo') ? 640 : 0) },
        imageSourceHeight: { get: () => (index() === S('current') && S('isVideo') ? 360 : 0) },
        markerCount: { get: () => 0 },
      },
      {
        getItemInfo: (attr) => {
          const a = String(attr).toLowerCase();
          if (index() === S('current')) {
            if (a === 'wm/genre' || a === 'genre') return S('genre');
            if (a === 'wm/year' || a === 'year' || a === 'releasedate') return S('year');
            if (a === 'wm/tracknumber' || a === 'tracknumber') return S('trackNumber');
            if (a === 'bitrate') return String(S('bitrate') * 1000);
            if (a === 'sourceurl') return S('url');
            if (a === 'mediatype') return S('isVideo') ? 'video' : 'audio';
          }
          return itemInfo(item(), a);
        },
        setItemInfo: () => undefined,
        getAttributeName: (i) => ['Title', 'Author', 'WM/AlbumTitle', 'Duration'][Number(i)] ?? '',
        getItemInfoByType: (attr) => itemInfo(item(), String(attr)),
        isIdentical: (other) => other === media,
        isMemberOf: () => true,
        isReadOnlyItem: () => true,
        getMarkerName: () => '',
        getMarkerTime: () => 0,
      },
    );
  }
  const currentMedia = media(() => S('current'));
  const isAvailable = (name: unknown) => {
    const n = String(name).toLowerCase();
    const ps = S('playState');
    const count = S('items').length;
    switch (n) {
      case 'play': return count > 0 && ps !== 3;
      case 'pause': return ps === 3 || ps === 4 || ps === 5 || ps === 6;
      case 'stop': return ps === 2 || ps === 3 || ps === 4 || ps === 5 || ps === 6;
      case 'next': case 'previous': return count > 1;
      case 'fastforward': case 'fastreverse': return ps === 3 || ps === 2 || ps === 4 || ps === 5;
      default: return count > 0;
    }
  };
  const controls = model(
    {
      currentPosition: { get: () => S('position'), set: (v) => call('controls', 'seek', [Number(v)]) },
      currentPositionString: { get: () => (S('playState') <= 1 && S('position') === 0 ? '' : timeString(S('position'))) },
      currentPositionTimecode: { get: () => `[00000]${timeString(S('position'))}.00` },
      currentItem: { get: () => currentMedia },
      currentMarker: { get: () => 0 },
      audioLanguageCount: { get: () => 0 },
    },
    {
      play: () => call('controls', 'play'),
      pause: () => call('controls', 'pause'),
      stop: () => call('controls', 'stop'),
      next: () => call('controls', 'next'),
      previous: () => call('controls', 'previous'),
      fastForward: () => call('controls', 'fastForward'),
      fastReverse: () => call('controls', 'fastReverse'),
      playItem: () => call('controls', 'play'),
      step: () => undefined,
      isAvailable,
    },
  );
  const settings = model(
    {
      volume: { get: () => S('volume'), set: (v) => call('settings', 'volume', [Number(v)]) },
      mute: { get: () => S('mute'), set: (v) => call('settings', 'mute', [truthy(v)]) },
      balance: { get: () => S('balance'), set: (v) => call('settings', 'balance', [Number(v)]) },
      rate: { get: () => S('rate'), set: (v) => call('settings', 'rate', [Number(v)]) },
      autoStart: { get: () => true, set: () => undefined },
      playCount: { get: () => 1, set: () => undefined },
      enableErrorDialogs: { get: () => false, set: () => undefined },
      invokeURLs: { get: () => false, set: () => undefined },
      baseURL: { get: () => '', set: () => undefined },
      defaultFrame: { get: () => '', set: () => undefined },
    },
    {
      getMode: (m) => {
        const k = String(m).toLowerCase();
        return k === 'loop' ? S('loop') : k === 'shuffle' ? S('shuffle') : k === 'autorewind';
      },
      setMode: (m, v) => call('settings', 'setMode', [String(m).toLowerCase(), truthy(v)]),
      isAvailable: () => true,
    },
  );
  const playlistItems = () => S('items');
  const currentPlaylist = model(
    {
      count: { get: () => playlistItems().length },
      name: { get: () => 'Now Playing' },
      attributeCount: { get: () => 0 },
    },
    {
      item: (i) => media(() => Number(i)),
      appendItem: () => undefined,
      insertItem: () => undefined,
      removeItem: () => undefined,
      moveItem: (a, b) => call('playlist', 'move', [Number(a), Number(b)]),
      getItemInfo: () => '',
      setItemInfo: () => undefined,
      isIdentical: () => true,
      attributeName: () => '',
    },
  );
  const network = model({
    downloadProgress: { get: () => 100 },
    bufferingProgress: { get: () => 100 },
    bufferingCount: { get: () => 0 },
    bufferingTime: { get: () => 0 },
    bitRate: { get: () => S('bitrate') * 1000 },
    bandWidth: { get: () => S('bitrate') * 1000 },
    receptionQuality: { get: () => 100 },
    sourceProtocol: { get: () => 'file' },
  });
  const stubCollection = model({ count: { get: () => 0 } }, {
    getAll: () => currentPlaylist,
    getByName: () => currentPlaylist,
    getByAttribute: () => currentPlaylist,
    getByAlbum: () => currentPlaylist,
    getByAuthor: () => currentPlaylist,
    getByGenre: () => currentPlaylist,
    getAll2: () => currentPlaylist,
    item: () => null,
  });
  const player = model(
    {
      URL: { get: () => S('url'), set: (v) => call('player', 'url', [String(v)]) },
      playState: { get: () => S('playState') },
      openState: { get: () => S('openState') },
      status: { get: () => S('status') },
      controls: { get: () => controls },
      settings: { get: () => settings },
      currentMedia: { get: () => currentMedia },
      currentPlaylist: { get: () => currentPlaylist },
      network: { get: () => network },
      error: { get: () => model({ errorCount: { get: () => 0 } }, { clearErrorQueue: () => undefined, item: () => null, webHelp: () => undefined }) },
      mediaCollection: { get: () => stubCollection },
      playlistCollection: { get: () => stubCollection },
      cdromCollection: { get: () => model({ count: { get: () => 0 } }, { item: () => null }) },
      closedCaption: { get: () => model({}) },
      dvd: { get: () => model({}) },
      isOnline: { get: () => false },
      versionInfo: { get: () => '9.0.0.4503' },
      fullScreen: { get: () => false, set: () => undefined },
      uiMode: { get: () => 'full', set: () => undefined },
      enabled: { get: () => true },
    },
    {
      close: () => call('controls', 'stop'),
      launchURL: (u) => call('player', 'launchURL', [String(u)]),
      newMedia: () => currentMedia,
      newPlaylist: () => currentPlaylist,
      openPlayer: () => undefined,
    },
  );
  const mediacenter = new Proxy({} as Obj, {
    has: () => false,
    get: (_, p) => {
      if (typeof p !== 'string') return undefined;
      track(`mc.${p.toLowerCase()}`);
      return local[`mc.${p.toLowerCase()}`];
    },
    set: (_, p, v) => {
      if (typeof p === 'string') {
        const key = `mc.${p.toLowerCase()}`;
        if (local[key] === v) return true;
        local[key] = v;
        notify(key);
        // WMP kept this across sessions and skins.
        if (v !== undefined && v !== null && typeof v !== 'object') call('theme', 'savePreference', [key, String(v)]);
      }
      return true;
    },
  });

  // ---- theme -------------------------------------------------------------

  const theme = model(
    {
      title: { get: () => init.theme.title ?? '' },
      author: { get: () => init.theme.author ?? '' },
      copyright: { get: () => init.theme.copyright ?? '' },
      authorVersion: { get: () => init.theme.authorversion ?? '' },
      version: { get: () => 1 },
      currentViewID: { get: () => root?.id ?? '', set: (v) => call('theme', 'switchView', [String(v)]) },
    },
    {
      openView: (id) => call('theme', 'openView', [String(id)]),
      openViewRelative: (id, l, t) => call('theme', 'openView', [String(id), Number(l), Number(t)]),
      closeView: (id) => call('theme', 'closeView', [String(id)]),
      loadPreference: (k) => {
        const key = String(k).toLowerCase();
        return key in init.prefs ? init.prefs[key] : '--';
      },
      savePreference: (k, v) => {
        const key = String(k).toLowerCase();
        init.prefs[key] = String(v);
        call('theme', 'savePreference', [key, String(v)]);
      },
      playSound: (f) => call('theme', 'playSound', [String(f)]),
      openDialog: () => {
        call('theme', 'openDialog');
        return '';
      },
      logString: (s) => console.log('[skin]', s),
      loadString: () => '',
      showErrorDialog: () => undefined,
    },
  );

  // ---- elements ----------------------------------------------------------

  const AMBIENT = new Set([
    'id', 'left', 'top', 'width', 'height', 'right', 'bottom', 'visible', 'enabled', 'zindex', 'alphablend', 'clippingimage', 'clippingcolor',
    'horizontalalignment', 'verticalalignment', 'resizeimages', 'passthrough', 'tabstop', 'elementtype', 'accname', 'accdescription', 'acckeyboardshortcut',
    'tooltip', 'uptooltip', 'downtooltip', 'down', 'sticky', 'image', 'hoverimage', 'downimage', 'hoverdownimage', 'disabledimage', 'value', 'min', 'max',
    'cursor', 'backgroundimage', 'backgroundcolor', 'foregroundcolor', 'transparencycolor',
  ]);

  const imageSize = (name: unknown) => (typeof name === 'string' ? init.images[name.replace(/\\/g, '/').split('/').pop()!.toLowerCase()] : undefined);

  let measureCtx: CanvasRenderingContext2D | null = null;
  const textWidth = (el: El) => {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return 0;
    const style = String(el.attrs.fontstyle ?? '').toLowerCase();
    const px = (Number(el.attrs.fontsize ?? 10) * 96) / 72;
    measureCtx.font = `${style.includes('italic') ? 'italic ' : ''}${style.includes('bold') ? 'bold ' : ''}${px}px ${String(el.attrs.fontface ?? 'Tahoma')}, Tahoma, Arial, sans-serif`;
    return Math.ceil(measureCtx.measureText(String(el.attrs.value ?? '')).width);
  };

  function fire(el: El, handler: string, args: Record<string, unknown> = {}, event: Obj | null = null): void {
    const code = el.handlers[handler];
    if (code === undefined) return;
    const names = Object.keys(args);
    let fn = el.compiled[`${handler}(${names.join(',')})`];
    if (!fn) {
      try {
        fn = new Function(...names, '__el', '__scope', `with(__scope){with(__el){${code.replace(/^\s*jscript\s*:/i, '')}\n}}`) as Fn;
      } catch (e) {
        report(`${el.id ?? el.tag}.${handler}`, e);
        fn = () => undefined;
      }
      el.compiled[`${handler}(${names.join(',')})`] = fn;
    }
    const prev = currentEvent;
    currentEvent = event ?? currentEvent;
    try {
      fn(...names.map((n) => args[n]), el.proxy, handlerScope);
    } catch (e) {
      report(`${el.id ?? el.tag}.${handler}`, e);
    } finally {
      currentEvent = prev;
    }
  }

  function setAttr(el: El, name: string, value: unknown, source: 'script' | 'host' | 'binding' | 'load'): void {
    if (el.special?.set(name, value)) return;
    if (name === 'value' && (el.tag === 'slider' || el.tag === 'customslider' || el.tag === 'progressbar')) {
      const n = Number(value);
      const min = Number(el.attrs.min ?? 0);
      const max = Number(el.attrs.max ?? 100);
      // Out of range is ignored, as WMP does (but not while max is still 0).
      if (!Number.isFinite(n) || (max > min && (n < min - 1e-9 || n > max + 1e-9))) return;
      value = n;
    }
    if (Object.is(el.attrs[name], value)) return;
    el.attrs[name] = value;
    if (source !== 'host') queuePatch(el.iid, name, value);
    if (name === 'value' && el.tag === 'text' && el.attrs.__autowidth) setAttr(el, 'width', textWidth(el), 'load');
    notify(`${el.iid}.${name}`);
    if (source !== 'load') fire(el, `${name}_onchange`);
  }

  function animate(el: El, target: Record<string, number>, ms: number, eased: boolean, done: string) {
    const from: Record<string, number> = {};
    for (const k of Object.keys(target)) from[k] = Number(el.attrs[k] ?? 0);
    const start = Date.now();
    const total = Math.max(0, Number(ms) || 0);
    const key = Object.keys(target).join();
    const token = {};
    (el as unknown as Record<string, unknown>)[`__anim_${key}`] = token;
    const step = () => {
      if ((el as unknown as Record<string, unknown>)[`__anim_${key}`] !== token) return;
      const t = total === 0 ? 1 : Math.min(1, (Date.now() - start) / total);
      const k = eased ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : t;
      for (const [name, to] of Object.entries(target)) setAttr(el, name, Math.round(from[name] + (to - from[name]) * k), 'script');
      if (t < 1) setTimeout(step, 16);
      else fire(el, done);
    };
    step();
  }

  function proxyFor(el: El): Obj {
    return new Proxy({} as Obj, {
      has: (_, p) => {
        if (typeof p !== 'string') return false;
        const k = p.toLowerCase();
        return k in el.attrs || k in el.methods || k in el.handlers || AMBIENT.has(k) || (el.special?.has(k) ?? false) || k === 'textwidth' || k === 'buttoncount' || k === 'index';
      },
      get: (_, p) => {
        if (typeof p !== 'string') return undefined;
        const k = p.toLowerCase();
        if (k in el.methods) return el.methods[k];
        if (el.special?.has(k)) return el.special.get(k);
        if (k === 'elementtype') return el.otag.toUpperCase();
        if (k === 'textwidth') {
          track(`${el.iid}.value`);
          return textWidth(el);
        }
        if (k === 'buttoncount') return el.children.length;
        if (k === 'index') return el.parent ? el.parent.children.indexOf(el) : 0;
        if (k === 'id') return el.id ?? '';
        track(`${el.iid}.${k}`);
        if (k in el.handlers) return el.handlers[k];
        const v = el.attrs[k];
        if (v === undefined) {
          if (k === 'visible' || k === 'enabled') return true;
          if (k === 'alphablend') return 255;
          if (k === 'down' || k === 'sticky') return false;
          if (k === 'zindex' || k === 'left' || k === 'top') return 0;
          if (k === 'right' && el.parent) return Number(el.parent.attrs.width ?? 0) - Number(el.attrs.left ?? 0) - Number(el.attrs.width ?? 0);
          if (k === 'bottom' && el.parent) return Number(el.parent.attrs.height ?? 0) - Number(el.attrs.top ?? 0) - Number(el.attrs.height ?? 0);
        }
        return v;
      },
      set: (_, p, v) => {
        if (typeof p !== 'string') return true;
        const k = p.toLowerCase();
        if (k === 'right' && el.parent) setAttr(el, 'left', Number(el.parent.attrs.width ?? 0) - Number(v) - Number(el.attrs.width ?? 0), 'script');
        else if (k === 'bottom' && el.parent) setAttr(el, 'top', Number(el.parent.attrs.height ?? 0) - Number(v) - Number(el.attrs.height ?? 0), 'script');
        else if (/^on|_onchange$/.test(k) && typeof v === 'string') {
          el.handlers[k] = v;
          el.compiled = {};
          queuePatch(el.iid, '__handlers', Object.keys(el.handlers));
        } else setAttr(el, k, v, 'script');
        return true;
      },
    });
  }

  const handlerScope = new Proxy({} as Obj, {
    has: (_, p) => typeof p === 'string' && (p === 'player' || p === 'theme' || p === 'view' || p === 'event' || p === 'mediacenter' || byId.has(p) || exported.has(p)),
    get: (_, p) => {
      if (typeof p !== 'string') return undefined;
      if (p === 'player') return player;
      if (p === 'theme') return theme;
      if (p === 'view') return root?.proxy;
      if (p === 'event') return currentEvent;
      if (p === 'mediacenter') return mediacenter;
      const el = byId.get(p);
      if (el) return el.proxy;
      return exported.get(p)?.[0]();
    },
    set: (_, p, v) => {
      if (typeof p === 'string') exported.get(p)?.[1](v);
      return true;
    },
  });
  const scriptScope = new Proxy({} as Obj, {
    has: (_, p) => typeof p === 'string' && (p === 'player' || p === 'theme' || p === 'view' || p === 'event' || p === 'mediacenter' || byId.has(p)),
    get: (_, p) => (typeof p === 'string' && !exported.has(p) ? Reflect.get(handlerScope, p) : undefined),
    set: () => true,
  });

  const evalIn = (el: El, expr: string): unknown => {
    const code = expr.replace(/^\s*(jscript|wmpprop)\s*:/i, '').trim().replace(/;+\s*$/, '');
    const fn = new Function('__el', '__scope', `with(__scope){with(__el){return (${code}\n);}}`) as Fn;
    return fn(el.proxy, handlerScope);
  };

  // Special elements whose attributes are the player's.
  function eqSpecial(): El['special'] {
    const names = new Set(['bypass', 'bands', 'currentpreset', 'currentpresettitle', 'presetcount', 'enablesplinetension', 'splinetension', 'crossfade', 'crossfadewindow',
      'normalization', 'normalizationaverage', 'normalizationpeak', 'enhancedaudio', 'speakersize', 'currentspeakername', 'trubasslevel', 'wowlevel', 'enable', 'classid']);
    return {
      has: (k) => names.has(k) || /^gainlevel(\d+)$/.test(k),
      get: (k) => {
        const g = /^gainlevel(\d+)$/.exec(k);
        if (g) return S('bands')[Number(g[1]) - 1] ?? 0;
        if (k === 'bypass') return !S('eqOn');
        if (k === 'bands') return 10;
        if (k === 'currentpreset') return S('eqPreset');
        if (k === 'currentpresettitle') return init.eqPresets[S('eqPreset')] ?? 'Custom';
        if (k === 'presetcount') return init.eqPresets.length;
        if (k === 'currentspeakername') return 'Normal Speakers';
        return local[`eq.${k}`] ?? (k === 'splinetension' ? 3 : k === 'enablesplinetension' ? true : k === 'trubasslevel' || k === 'wowlevel' ? 50 : false);
      },
      set: (k, v) => {
        const g = /^gainlevel(\d+)$/.exec(k);
        if (g) call('eq', 'band', [Number(g[1]) - 1, Number(v)]);
        else if (k === 'bypass') call('eq', 'on', [!truthy(v)]);
        else if (k === 'currentpreset') call('eq', 'preset', [Number(v)]);
        else if (names.has(k)) {
          local[`eq.${k}`] = v;
          if (k === 'crossfade' || k === 'crossfadewindow') call('eq', 'crossfade', [truthy(local['eq.crossfade']), Number(local['eq.crossfadewindow'] ?? 250)]);
          if (k === 'normalization') call('eq', 'quiet', [truthy(v)]);
          if (k === 'enhancedaudio' || k === 'trubasslevel') call('eq', 'bass', [truthy(local['eq.enhancedaudio']) ? Number(local['eq.trubasslevel'] ?? 50) : 0]);
        } else return false;
        return true;
      },
    };
  }

  const EFFECT_ATTRS = new Set(['currenteffect', 'currenteffecttype', 'currenteffecttitle', 'currentpreset', 'currentpresettitle', 'currenteffectpresetcount', 'effectcount', 'fullscreen', 'effectcangofullscreen', 'effecthaspropertypage', 'allowall', 'windowed']);
  function effectsSetup(el: El) {
    const fx = init.effects;
    const state = () => {
      track(`${el.iid}.__effect`);
      track(`${el.iid}.currentpreset`);
      return { e: Number(el.attrs.__effect ?? 0), p: Number(el.attrs.currentpreset ?? 0) };
    };
    const go = (e: number, p: number) => {
      const ei = ((e % fx.length) + fx.length) % fx.length;
      const count = fx[ei].presets.length;
      setAttr(el, '__effect', ei, 'script');
      setAttr(el, 'currentpreset', ((p % count) + count) % count, 'script');
      mediacenter.effecttype = fx[ei].type;
      mediacenter.effectpreset = el.attrs.currentpreset;
    };
    el.special = {
      has: (k) => EFFECT_ATTRS.has(k),
      get: (k) => {
        const { e, p } = state();
        const cur = fx[e] ?? fx[0];
        switch (k) {
          case 'currenteffecttype': return cur.type;
          case 'currenteffecttitle': return cur.title;
          case 'currentpreset': return p;
          case 'currentpresettitle': return cur.presets[p] ?? '';
          case 'currenteffectpresetcount': return cur.presets.length;
          case 'effectcount': return fx.length;
          case 'currenteffect': return model({ title: { get: () => cur.title } });
          case 'fullscreen': return false;
          case 'effectcangofullscreen': return false;
          case 'effecthaspropertypage': return false;
          default: return el.attrs[k];
        }
      },
      set: (k, v) => {
        if (k === 'currenteffecttype') {
          const i = fx.findIndex((f) => f.type.toLowerCase() === String(v).toLowerCase());
          if (i >= 0) go(i, 0);
          return true;
        }
        if (k === 'currentpreset') {
          // Skins restore this from WMP's own memory, which may be empty.
          if (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) return true;
          const { e } = state();
          const count = fx[e].presets.length;
          const p = ((Math.round(Number(v)) % count) + count) % count;
          if (el.attrs.currentpreset !== p) {
            el.attrs.currentpreset = p;
            queuePatch(el.iid, 'currentpreset', p);
            notify(`${el.iid}.currentpreset`);
          }
          return true;
        }
        if (k === 'fullscreen') return true;
        return false;
      },
    };
    const step = (d: number, within: boolean) => {
      const { e, p } = state();
      const count = fx[e].presets.length;
      if (within) go(e, p + d);
      else if (p + d >= count) go(e + 1, 0);
      else if (p + d < 0) go(e - 1, fx[(e - 1 + fx.length) % fx.length].presets.length - 1);
      else go(e, p + d);
    };
    Object.assign(el.methods, {
      next: () => step(1, false),
      previous: () => step(-1, false),
      nextpreset: () => step(1, true),
      previouspreset: () => step(-1, true),
      nexteffect: () => go(state().e + 1, 0),
      previouseffect: () => go(state().e - 1, 0),
      effecttitle: (i: unknown) => fx[Number(i)]?.title ?? '',
      effecttype: (i: unknown) => fx[Number(i)]?.type ?? '',
      settings: () => undefined,
    });
    const savedType = local['mc.effecttype'];
    const i = typeof savedType === 'string' ? fx.findIndex((f) => f.type === savedType) : -1;
    // A visualization rather than album art, unless the skin chose before.
    el.attrs.__effect = i >= 0 ? i : Math.min(1, fx.length - 1);
  }

  function listSetup(el: El) {
    const items = (): string[] => {
      track(`${el.iid}.__items`);
      return (el.attrs.__items as string[] | undefined) ?? [];
    };
    const setItems = (list: string[]) => setAttr(el, '__items', list, 'script');
    el.attrs.__items ??= el.children.filter((c) => c.tag === 'item').map((c) => String(c.attrs.value ?? ''));
    el.attrs.__selected ??= [];
    Object.assign(el.methods, {
      appenditem: (t: unknown) => setItems([...items(), String(t)]),
      insertitem: (i: unknown, t: unknown) => {
        const l = items().slice();
        l.splice(Number(i), 0, String(t));
        setItems(l);
      },
      deleteitem: (i: unknown) => setItems(items().filter((_, n) => n !== Number(i))),
      deleteall: () => setItems([]),
      replaceitem: (i: unknown, t: unknown) => setItems(items().map((x, n) => (n === Number(i) ? String(t) : x))),
      getitem: (i: unknown) => items()[Number(i)] ?? '',
      finditem: (start: unknown, t: unknown) => items().findIndex((x, n) => n >= Number(start) && x === String(t)),
      getnextselecteditem: (i: unknown) => {
        const sel = (el.attrs.__selected as number[]) ?? [];
        return sel.filter((n) => n > Number(i)).sort((a, b) => a - b)[0] ?? -1;
      },
      setselectedstate: (i: unknown, on: unknown) => {
        const sel = new Set((el.attrs.__selected as number[]) ?? []);
        if (truthy(on)) sel.add(Number(i));
        else sel.delete(Number(i));
        setAttr(el, '__selected', [...sel], 'script');
      },
      show: () => setAttr(el, '__shown', true, 'script'),
      dismiss: () => setAttr(el, '__shown', false, 'script'),
    });
    el.special = {
      has: (k) => k === 'itemcount',
      get: () => items().length,
      set: () => false,
    };
  }

  function playlistSetup(el: El) {
    el.attrs.__selected ??= [];
    const selected = (): number[] => {
      track(`${el.iid}.__selected`);
      return (el.attrs.__selected as number[]) ?? [];
    };
    Object.assign(el.methods, {
      getnextselecteditem: (i: unknown) => selected().filter((n) => n > Number(i)).sort((a, b) => a - b)[0] ?? -1,
      getnextselecteditem2: (i: unknown) => selected().filter((n) => n > Number(i)).sort((a, b) => a - b)[0] ?? -1,
      getnextcheckeditem: () => -1,
      setselectedstate: (i: unknown, on: unknown) => {
        const n = Number(i);
        const sel = new Set(selected());
        if (n === -1) {
          if (truthy(on)) S('items').forEach((_, k) => sel.add(k));
          else sel.clear();
        } else if (truthy(on)) sel.add(n);
        else sel.delete(n);
        setAttr(el, '__selected', [...sel], 'script');
      },
      deleteselected: () => call('playlist', 'remove', [selected()], el.iid),
      deleteselectedfromlibrary: () => call('playlist', 'remove', [selected()], el.iid),
      moveselectedup: () => call('playlist', 'moveUp', [selected()], el.iid),
      moveselecteddown: () => call('playlist', 'moveDown', [selected()], el.iid),
      sortcolumn: (i: unknown) => call('playlist', 'sort', [Number(i)], el.iid),
      itemmedia: (i: unknown) => media(() => Number(i)),
      itemplaylist: () => currentPlaylist,
      setcolumnwidth: () => undefined,
      setcolumnresizemode: () => undefined,
      addselectedtoplaylist: () => undefined,
      copy: () => undefined,
      abortcopy: () => undefined,
    });
    el.special = { has: (k) => k === 'itemcount' || k === 'columncount', get: (k) => (k === 'itemcount' ? S('items').length : 2), set: () => false };
  }

  function setupMethods(el: El) {
    const anim = {
      moveto: (l: unknown, t: unknown, ms: unknown) => animate(el, { left: Number(l), top: Number(t) }, Number(ms), false, 'onendmove'),
      slideto: (l: unknown, t: unknown, ms: unknown) => animate(el, { left: Number(l), top: Number(t) }, Number(ms), true, 'onendmove'),
      movesizeto: (l: unknown, t: unknown, w: unknown, h: unknown, ms: unknown, slide: unknown) =>
        animate(el, { left: Number(l), top: Number(t), width: Number(w), height: Number(h) }, Number(ms), truthy(slide), 'onendmove'),
      alphablendto: (a: unknown, ms: unknown) => animate(el, { alphablend: Number(a) }, Number(ms), false, 'onendalphablend'),
    };
    Object.assign(el.methods, anim);
    switch (el.tag) {
      case 'view':
        Object.assign(el.methods, {
          close: () => {
            fire(el, 'onclose');
            call('view', 'close');
          },
          minimize: () => call('view', 'minimize'),
          maximize: () => undefined,
          restore: () => undefined,
          returntomediacenter: () => call('view', 'returnToMediaCenter'),
          size: () => undefined,
        });
        break;
      case 'button':
      case 'buttonelement':
        el.methods.click = () => fire(el, 'onclick');
        break;
      case 'buttongroup':
        el.methods.getbutton = (i: unknown) => el.children[Number(i)]?.proxy ?? null;
        el.methods.click = (i: unknown) => {
          const b = el.children[Number(i)];
          if (b) fire(b, 'onclick');
        };
        break;
      case 'effects':
        effectsSetup(el);
        break;
      case 'equalizersettings':
        el.special = eqSpecial();
        Object.assign(el.methods, {
          reset: () => call('eq', 'reset'),
          nextpreset: () => call('eq', 'preset', [(S('eqPreset') + 1) % init.eqPresets.length]),
          previouspreset: () => call('eq', 'preset', [(S('eqPreset') - 1 + init.eqPresets.length) % init.eqPresets.length]),
          presettitle: (i: unknown) => init.eqPresets[Number(i)] ?? '',
          gainlevels: (i: unknown) => S('bands')[Number(i) - 1] ?? 0,
        });
        break;
      case 'videosettings':
        el.methods.reset = () => {
          for (const k of ['brightness', 'contrast', 'hue', 'saturation']) setAttr(el, k, 0, 'script');
        };
        break;
      case 'listbox':
      case 'popup':
        listSetup(el);
        break;
      case 'playlist':
        playlistSetup(el);
        break;
      case 'editbox':
        Object.assign(el.methods, {
          getline: () => String(el.attrs.value ?? ''),
          getlinefromchar: () => 0,
          getlineindex: () => 0,
          getselectionstart: () => 0,
          getselectionend: () => 0,
          setselection: () => undefined,
          replaceselection: (t: unknown) => setAttr(el, 'value', String(el.attrs.value ?? '') + String(t), 'script'),
        });
        el.special = { has: (k) => k === 'linecount', get: () => 1, set: () => false };
        break;
      case 'automenu':
        el.methods.show = () => call('automenu', 'show', [], el.iid);
        break;
    }
  }

  const isHandler = (el: El, name: string) =>
    name.startsWith('on') || name.endsWith('_onchange') ||
    (el.tag === 'player' && /^(playstatechange|openstatechange|mediachange|currentitemchange|modechange|positionchange|statuschange|buffering|error|currentplaylistchange|playlistchange|mediaerror|currentmediaitemavailable|scriptcommand|markerhit|cdrommediachange|domainchange|audiolanguagechange|openplaylistswitch|mediacollectionchange|playlistcollectionchange)$/.test(name));

  /** Default sizes: from images, and TEXT from its text. */
  function sizeDefaults(el: El) {
    const img =
      el.tag === 'view' || el.tag === 'subview' ? imageSize(el.attrs.backgroundimage)
        : el.tag === 'customslider' ? imageSize(el.attrs.positionimage)
          : el.tag === 'slider' || el.tag === 'progressbar' ? imageSize(el.attrs.backgroundimage) ?? imageSize(el.attrs.foregroundimage)
            : el.tag === 'buttongroup' ? imageSize(el.attrs.mappingimage) ?? imageSize(el.attrs.image)
              : imageSize(el.attrs.image);
    if (el.tag === 'view') {
      el.attrs.width ??= img?.w ?? init.viewWidth;
      el.attrs.height ??= img?.h ?? init.viewHeight;
    } else if (el.tag === 'text') {
      if (el.attrs.width === undefined) {
        el.attrs.__autowidth = true;
        el.attrs.width = textWidth(el);
      }
      el.attrs.height ??= Math.ceil(((Number(el.attrs.fontsize ?? 10) * 96) / 72) * 1.25);
    } else if (img) {
      el.attrs.width ??= img.w;
      el.attrs.height ??= img.h;
    } else if (el.tag === 'subview' && el.parent) {
      el.attrs.width ??= el.parent.attrs.width;
      el.attrs.height ??= el.parent.attrs.height;
    }
  }

  const bad = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isNaN(v));

  /** Build elements in document order, resolving attributes as WMP does at load. */
  function build(node: VmNode, parentEl: El | null, bindings: Binding[]): El {
    const el: El = {
      iid: node.iid, tag: node.tag, otag: node.originalTag, id: node.attrs.id ?? null, attrs: {}, handlers: {}, parent: parentEl, children: [], proxy: {}, compiled: {}, methods: {},
    };
    el.proxy = proxyFor(el);
    elements.set(el.iid, el);
    if (el.id) byId.set(el.id, el);
    if (parentEl) parentEl.children.push(el);
    else root = el;
    for (const [name, raw] of Object.entries(node.attrs)) {
      if (name === 'id') continue;
      if (isHandler(el, name)) {
        el.handlers[name] = raw;
        continue;
      }
      const prefix = /^\s*(wmpprop|wmpenabled|wmpdisabled|jscript)\s*:/i.exec(raw);
      if (!prefix) {
        el.attrs[name] = coerce(el, name, raw);
        continue;
      }
      const kind = prefix[1].toLowerCase();
      const rest = raw.slice(prefix[0].length).trim().replace(/;+\s*$/, '');
      if (kind === 'jscript') {
        let v: unknown;
        try {
          v = evalIn(el, rest);
        } catch {
          v = undefined;
        }
        // Refers to something not built yet: tried again once all exist.
        if (bad(v)) bindings.push({ el, attr: name, fn: () => evalIn(el, rest), deps: new Set() });
        else el.attrs[name] = v;
      } else {
        const expr = kind === 'wmpprop' ? rest : `${kind === 'wmpdisabled' ? '!' : ''}player.controls.isAvailable('${rest.replace(/^player\.controls\./i, '')}')`;
        bindings.push({ el, attr: name, fn: () => evalIn(el, expr), deps: new Set() });
      }
    }
    sizeDefaults(el);
    for (const child of node.children) build(child, el, bindings);
    setupMethods(el);
    return el;
  }

  function collectNames(src: string): string[] {
    const names = new Set<string>();
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^var\s+([^;\n]+)/gm)) {
      for (const part of m[1].split(',')) {
        const id = /^\s*([A-Za-z_$][\w$]*)\s*(=|$)/.exec(part);
        if (id) names.add(id[1]);
      }
    }
    return [...names];
  }

  function loadScripts(sources: string[]) {
    const run = (src: string) => {
      const names = collectNames(src);
      const binder = names.map((n) => `${JSON.stringify(n)}:[function(){try{return ${n}}catch(e){}},function(v){${n}=v}]`).join(',');
      const fn = new Function('__scope', `with(__scope){\n${src}\n}\nreturn {${binder}};`) as (s: Obj) => Record<string, [() => unknown, (v: unknown) => void]>;
      const out = fn(scriptScope);
      for (const [k, v] of Object.entries(out)) exported.set(k, v);
    };
    try {
      run(sources.join('\n;\n'));
    } catch (e) {
      // One bad file shouldn't take the others down.
      report('script', e);
      for (const s of sources) {
        try {
          run(s);
        } catch (err) {
          report('script', err);
        }
      }
    }
  }

  function serialize(el: El, out: Record<string, Obj>) {
    const attrs: Obj = {};
    for (const [k, v] of Object.entries(el.attrs)) if (typeof v !== 'function' && (typeof v !== 'object' || v === null || Array.isArray(v))) attrs[k] = v;
    attrs.__handlers = Object.keys(el.handlers);
    out[el.iid] = attrs;
    for (const c of el.children) serialize(c, out);
  }

  // ---- player events -----------------------------------------------------

  const playerEls = () => [...elements.values()].filter((e) => e.tag === 'player' || e.tag === 'settings' || e.tag === 'controls' || e.tag === 'equalizersettings');
  function firePlayer(name: string, args: Record<string, unknown> = {}) {
    for (const el of playerEls()) {
      if (el.tag !== 'player') continue;
      if (el.handlers[name] !== undefined) fire(el, name, args);
      else if (el.handlers[`on${name}`] !== undefined) fire(el, `on${name}`, args);
    }
  }
  function fireChange(tag: string, attr: string) {
    for (const el of playerEls()) if (el.tag === tag) fire(el, `${attr}_onchange`);
  }

  function applySnapshot(next: PlayerSnapshot) {
    const prev = snap;
    snap = next;
    const changed = (Object.keys(next) as (keyof PlayerSnapshot)[]).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    for (const k of changed) notify(`snap.${k}`);
    if (!prev.status) return;
    if (changed.includes('mediaKey')) {
      firePlayer('openstatechange', { NewState: 8 });
      firePlayer('mediachange', { Item: currentMedia });
      firePlayer('currentitemchange');
      fireChange('player', 'url');
      firePlayer('openstatechange', { NewState: 13 });
      fireChange('player', 'openstate');
    }
    if (changed.includes('playState')) {
      firePlayer('playstatechange', { NewState: next.playState });
      fireChange('player', 'playstate');
    }
    if (changed.includes('status')) firePlayer('statuschange');
    if (changed.includes('position')) {
      fireChange('controls', 'currentposition');
      if (Math.abs(next.position - prev.position) > 2) firePlayer('positionchange', { oldPosition: prev.position, newPosition: next.position });
    }
    if (changed.includes('volume')) fireChange('settings', 'volume');
    if (changed.includes('mute')) fireChange('settings', 'mute');
    if (changed.includes('balance')) fireChange('settings', 'balance');
    if (changed.includes('loop')) firePlayer('modechange', { ModeName: 'loop', NewValue: next.loop });
    if (changed.includes('shuffle')) firePlayer('modechange', { ModeName: 'shuffle', NewValue: next.shuffle });
    if (changed.includes('items')) firePlayer('currentplaylistchange', { change: 0 });
    for (const el of playerEls()) {
      if (el.tag !== 'equalizersettings') continue;
      if (changed.includes('bands')) next.bands.forEach((b, i) => b !== prev.bands?.[i] && fire(el, `gainlevel${i + 1}_onchange`));
      if (changed.includes('eqOn')) fire(el, 'bypass_onchange');
      if (changed.includes('eqPreset')) fire(el, 'currentpreset_onchange');
    }
  }

  // ---- messages ----------------------------------------------------------

  /** VIEW ontimer, every timerInterval (which scripts change, or set to 0 to stop). */
  function tick() {
    const interval = Number(root?.attrs.timerinterval ?? 1000);
    if (root && root.handlers.ontimer !== undefined && interval >= 50) fire(root, 'ontimer');
    setTimeout(tick, interval >= 50 ? interval : 250);
  }

  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== parent) return;
    const msg = e.data as HostToVm;
    try {
      if (msg.type === 'init') {
        init = msg;
        snap = msg.player;
        for (const [k, v] of Object.entries(msg.prefs)) if (k.startsWith('mc.')) local[k] = v;
        const bindings: Binding[] = [];
        const viewEl = build(msg.view, null, bindings);
        for (const b of bindings) runBinding(b);
        loadScripts(msg.scripts);
        const out: Record<string, Obj> = {};
        serialize(viewEl, out);
        post({ type: 'patch', patch: out });
        post({ type: 'ready' });
        fire(viewEl, 'onload');
        tick();
      } else if (msg.type === 'player') {
        applySnapshot(msg.player);
      } else if (msg.type === 'attrs') {
        const el = elements.get(msg.iid);
        if (el) for (const [k, v] of Object.entries(msg.attrs)) setAttr(el, k, v, 'host');
      } else if (msg.type === 'event') {
        const el = elements.get(msg.iid);
        if (!el) return;
        if (msg.attrs) for (const [k, v] of Object.entries(msg.attrs)) setAttr(el, k, v, 'host');
        const ev: Obj = { altKey: false, ctrlKey: false, shiftKey: false, button: 0, keyCode: 0, ...(msg.event ?? {}), srcElement: el.proxy };
        fire(el, `on${msg.name}`, {}, ev);
      }
    } catch (err) {
      report(msg.type, err);
    }
  });

  post({ type: 'booted' });
}
