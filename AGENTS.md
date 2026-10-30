# Project Overview

**Din is a social computer** — a web-native desktop environment (windows, taskbar, apps, login) built as a Vite + React 19 + TailwindCSS 4 + shadcn/ui app, hosted by a thin Electron shell. Users sign in with their Nostr account, and Din bridges that identity into every app on the desktop, storing data on Nostr relays and Blossom servers. **DinOS** is Din's flagship OS: a minimal NixOS system that boots straight into Din fullscreen (kernel → systemd → din-shell, Din's own compositor → Electron → Din). Din also runs windowed for development or as a plain web app in a browser. See `README.md` for full architecture, dev-loop tiers, and DinOS/Nix details.

## Commands

```sh
npm run dev         # Din in Electron with HMR (windowed + DevTools)
npm run dev:browser # Din in a plain browser with HMR (http://localhost:8080)
npm test            # type-check + lint + tests + build — THE validation script
npm run build       # build the web app into dist/
npm run os:build    # build the installable DinOS disk image
npm run os:run      # demo DinOS in a QEMU window
npm run perf:profile # headless performance run of the desktop (see Profiling)
```

## Profiling (never in a shipped build)

Runtime instrumentation exists only in profiling builds, gated on the compile-time `VITE_PROFILE=1` (`src/lib/perfRuntime.ts`, installed by `src/lib/perfRuntimeInstall.ts`; `npm run build:profile` for a hand-driven build, whose console then has `__dinPerf.runtime()`). Keep new probes behind the same guard. `scripts/perf-profile.mjs` builds into `dist-perf/`, drives Din headless in Chromium over the DevTools protocol (boot, idle, launching apps, dragging and raising windows, the apps menu, an open/close leak tour) and writes `perf-reports/`; `--only <scenarios>`, `--skip-build`, `--cpu-profile`, `--offline` and `--no-blur` are documented at the top of the script. It never publishes: every outbound EVENT gets a local OK. Measure before and after a performance change, on the same machine — headless rendering is software (SwiftShader), so frame times there overstate compositing cost on a real GPU.

## Technology Stack

- **React 19.x**: hooks, concurrent rendering, ref-as-prop
- **TailwindCSS 4.x**: utility-first styling
- **Vite**: dev server and production bundler
- **shadcn/ui**: unstyled accessible components on Radix UI + Tailwind (48+ components in `@/components/ui`)
- **Nostrify** (`@nostrify/react`): Nostr protocol framework
- **React Router**: client-side routing with `BrowserRouter` and automatic scroll-to-top
- **TanStack Query**: data fetching, caching, state
- **TypeScript**: type-safe JS. **Never use the `any` type.**

## Project Structure

- `/src/apps/` — the built-in apps (`din://<id>/`), each with `index.html`, `manifest.webmanifest`, `main.tsx` and its code; `/src/shared/` — code apps share (with each other or the desktop); `/src/sdk/` — `window.din` and its React pieces; `/src/widgets/` — the built-in desktop widgets (`widget://<id>/`), napplets that get only `window.napplet` (`docs/widgets.md`); `/src/platform/` — `GuestSurface`, the only code that knows `<webview>`.
- `/src/components/` — UI components. `ui/` holds shadcn/ui primitives; `auth/` holds login components (`LoginArea`, `AuthDialog`, `AccountSwitcher`).
- `/src/hooks/` — custom hooks. Discover the full set with `ls src/hooks/`. Key ones: `useNostr`, `useAuthor`, `useCurrentUser`, `useNostrPublish`, `useUploadFile`, `useAppContext`, `useTheme`, `useToast`, `useLoggedInAccounts`, `useLoginActions`, `useIsMobile`.
- `/src/pages/` — page components wired into React Router (`Index`, `NotFound`, `NIP19Page`).
- `/src/lib/` — utility functions and shared logic.
- `/src/contexts/` — React context providers (`AppContext`).
- `/src/test/` — testing utilities including the `TestApp` wrapper.
- `/public/` — static assets.
- `/electron/` — the Electron host: `main.mts`, `devtools-bridge.mts`, `userscripts.mts` (TypeScript run directly via Node's native type stripping in development; `npm run build` compiles it to gitignored `electron/*.mjs` via `scripts/build-electron.mjs`, which production runs so no process loads the stripper. Erasable syntax only, checked by `tsconfig.electron.json`. A module that names a sibling file at runtime must use `path.extname(import.meta.filename)`, not a literal `.mts`), plus `preload.cjs` and the guest preloads (`nostr-preload.cjs` etc.) (sandboxed preloads can't be ESM/TS; plain CommonJS with JSDoc types) and `pty-host.py` (fs/pty/wifi bridges behind the Files, Terminal, and Settings apps).
- `/os/` — DinOS, the flagship OS: `flake.nix` (entry point; exposes the installable disk image as `./os#image` and the QEMU demo as `./os#vm`) and `configuration.nix` (the whole OS: the din-shell compositor service + Electron launcher + Nix build of Din, targeting real hardware; QEMU-only accommodations live in its `vmVariant`). The Nix build only sees **git-tracked** files — `git add` new files before `npm run os:build` — and pins npm deps via `npmDepsHash` (refresh it after dependency changes; see README).
- `App.tsx` — **already configured** with `QueryClientProvider`, `NostrProvider`, `UnheadProvider`, `AppProvider`, `NostrLoginProvider`. **Read before editing**; changes are rarely needed.
- `AppRouter.tsx` — React Router configuration. The catch-all `/:nip19` route handles all NIP-19 identifiers (see the `nip19-routing` skill).

**Always read an existing file before modifying it.** Never write over `App.tsx`, `AppRouter.tsx`, or `NostrProvider` without first reading their contents.

## The App Platform

Din has three layers, and each talks only to the one below it (`docs/README.md`):

- **Electron main** (`electron/`): the system. It answers IPC from the desktop alone (`assertShellSender`), plus the bridge ports the desktop grants apps.
- **The desktop** (`src/`, at `app://din`): the window manager, Dock, menu bar, signer, and Din's system UI (Settings, System Monitor, App Store, the Web Browser, Screenshot, the Installer). It reaches the system only through **`window.dinos`**, by way of its `src/lib/` wrappers (`getFsBridge()`, …).
- **Built-in apps** (`src/apps/<id>/`, at `din://<id>/`): each window its own webview and process, reaching anything outside itself only through **`window.din`** (`@/sdk`, `@/sdk/react`).

**Application code never uses Electron IPC.** `ipcRenderer`, `contextBridge` and the `electron` module belong to the preloads in `electron/` and nowhere in `src/`: desktop code uses `window.dinos`, app code uses `window.din`. To give either something new, add it the layered way: a handler in main (checking `assertShellSender`), a namespace on `window.dinos` in `electron/preload.cjs` with its typed wrapper in `src/lib/`, and, if apps need it, a `window.din` API that `DinAppFrame` answers (or a bridge permission in `electron/din-apps.mts` for a direct port, like `fs` and `pty`). Lint enforces the boundaries: `src/` can't import `electron`; `src/apps/`, `src/shared/` and `src/sdk/` can't reach the desktop's internals or `window.dinos`; only `src/platform/` knows `<webview>`.

**Read `docs/README.md` before working on app hosting, window chrome, `<webview>`, the preload bridges, or any built-in app**, and the `docs/din/` page for the area you're touching. A new or moved app follows `docs/building-an-app.md` and `docs/migrating-builtin-apps.md`; code shared by apps (or apps and the desktop) goes in `src/shared/`, and must work in both documents. The API's types are `src/sdk/din.d.ts`; keep the docs and types in step with each other and with the code.

## UI Components

Components in `@/components/ui` are unstyled, accessible primitives styled with Tailwind. They follow a consistent React 19 pattern: plain function components that type props via `React.ComponentProps<...>` and forward `ref` as a normal prop (no `React.forwardRef`), tag their root with a `data-slot` attribute, merge classes with the `cn()` utility, and define variants with `class-variance-authority`. Components built on Radix import from the unified `radix-ui` package (e.g. `import { Dialog as DialogPrimitive } from "radix-ui"`), not individual `@radix-ui/react-*` packages. When you need a specific component, list the directory (`ls src/components/ui/`) or import from `@/components/ui/<name>` — all common primitives are present (buttons, inputs, dialogs, dropdowns, forms, tables, etc.).

## System Prompt Management

The assistant's behavior is defined by this file (`AGENTS.md`). Edit it directly to change guidelines — updates take effect the next session. Specialized workflows live in `/.agents/skills/` as loadable skills, discoverable through the `skill` tool.

## Nostr Protocol Integration

**Load the `nostr-dev` skill before building or modifying any Nostr feature** (events, queries, publishing, profiles, login, custom kinds). It covers NIP/kind selection, kind ranges, tag and content design, the `useNostr`/`useAuthor`/`useNostrPublish` hooks, `LoginArea`, NIP-19 basics, and pointers to the specialized skills (`nostr-security`, `nip19-routing`, `file-uploads`, `nostr-encryption`, `nostr-relay-pools`).

Two rules that always apply, even without the skill loaded:

- **Security:** where nostrd is running (always on DinOS) the keys live there and Din only asks it to sign (`src/lib/nostrd.ts`, `electron/nostrd.mts`); elsewhere `nsec` keys live in plaintext `localStorage`, so XSS = permanent key theft. Even with nostrd, XSS can still sign as the user. Never use `dangerouslySetInnerHTML`/`innerHTML` with untrusted data, never relax the CSP, sanitize event-sourced URLs/CSS, and filter by `authors` on trust-sensitive queries (admin data, addressable/replaceable events). Full threat model: `nostr-security` skill.
- **NIP-19 routing:** all identifiers (`npub1`, `note1`, `naddr1`, …) route at the URL root (`/:nip19` → `src/pages/NIP19Page.tsx`); decode to hex before querying. Details: `nip19-routing` skill.

## App Configuration

The `AppProvider` manages global state (theme + NIP-65 relay list), persisted to local storage.

```ts
const defaultConfig: AppConfig = {
  theme: 'light',
  relayMetadata: {
    relays: [
      { url: 'wss://relay.ditto.pub', read: true, write: true },
      { url: 'wss://relay.primal.net', read: true, write: true },
      { url: 'wss://relay.damus.io', read: true, write: true },
    ],
    updatedAt: 0,
  },
};
```

### Relay Management

- **`NostrSync`** auto-loads the user's NIP-65 relay list on login and writes it into `AppContext`.
- **Automatic publishing** — updating the relay config publishes a new kind 10002 event when the user is logged in.
- A drop-in settings UI (`RelayListManager`) is available as the **`relay-management`** skill.

## Routing

Routes live in `AppRouter.tsx`. To add one:

1. Create the page component in `src/pages/`.
2. Import it in `AppRouter.tsx`.
3. Add the route **above** the catch-all `*` route:

```tsx
<Route path="/your-path" element={<YourComponent />} />
```

The router provides automatic scroll-to-top on navigation and a 404 `NotFound` page. The `/:nip19` route is already wired (see the `nip19-routing` skill).

## Design Standards

Designs should be polished and production-ready. Concrete rules:

- **Responsive** down to ~360px; test mobile, tablet, desktop.
- **WCAG 2.1 AA**: ≥ 4.5:1 contrast for body text, ≥ 3:1 for large text and UI elements. Full keyboard nav, ARIA labels, visible `focus-visible` rings.
- **8px grid** for spacing (Tailwind's 4-based scale). Don't sprinkle `p-[13px]`-style one-offs.
- **Typography hierarchy**: ≥ 18px body, ≥ 40px primary headlines. Prefer a modern sans (e.g. Inter) for UI and pair a display/serif for headings when personality is needed.
- **Depth**: soft shadows, gentle gradients, rounded corners (`rounded-lg` / `rounded-xl`). Avoid heavy drop shadows.
- **Motion**: lightweight, purposeful (hover, scroll reveals, transitions). Respect `prefers-reduced-motion` with Tailwind's `motion-safe:` / `motion-reduce:` variants.
- **Reusable components**: consistent variants and feedback states (`hover`, `focus-visible`, `active`, `disabled`, `aria-invalid`). Use `cn()` for conditional classes and `class-variance-authority` for variants (copy an existing `ui/` component as a template).
- **Custom over generic**: avoid template-looking headers — combine layered visuals, subtle motion, and brand colors. Generate custom images with available tools before reaching for stock.

### Right-Click Menus

Din is a desktop, and desktop users right-click. **Don't neglect the context menu.** Anything a user can act on (list rows, sidebar entries, cards, tiles, tabs, files, conversations, items in a playlist or history) should open a right-click menu with the same actions its ⋯ button, toolbar, or hover buttons offer. If you add a ⋯ (`MoreHorizontal`) menu or hover-only actions to an item, add the matching right-click menu in the same change, and when building a new list or app, look for the places a user would right-click and give them something there.

- Use `ContextMenu` from `@/components/ui/context-menu` with `<ContextMenuTrigger asChild>` around the existing element (`src/shared/TabContextMenu.tsx` and `src/components/desktop/apps/files/Sidebar.tsx` are good models). A component used as the trigger must spread its extra props and accept `ref` onto its root.
- Mirror the ⋯ menu's items, labels, icons, and order, and destructive items keep `variant="destructive"` and their confirmation. Share the action code between both menus instead of duplicating it.
- Right-click on a row acts on that row, not on whatever is selected, unless the row is part of a multi-selection.
- An item that starts inline editing (Rename) must stop the closing menu from returning focus to the trigger (`onCloseAutoFocus` → `preventDefault()`), or the field blurs and saves immediately.
- Leave text fields, editors, and web content their native menu (cut/copy/paste/spellcheck); disable the trigger while an item is being edited.

### Loading and Empty States

**Use skeletons** for structured content (feeds, profiles, forms). **Use spinners** only for buttons or short operations.

```tsx
<Card>
  <CardHeader>
    <div className="flex items-center space-x-3">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="space-y-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  </CardHeader>
  <CardContent>
    <div className="space-y-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  </CardContent>
</Card>
```

For empty results, show a minimalist empty state in a `border-dashed` card:

```tsx
<Card className="border-dashed">
  <CardContent className="py-12 px-8 text-center">
    <p className="text-muted-foreground max-w-sm mx-auto">
      No results found. Try checking your relay connections or wait a moment for content to load.
    </p>
  </CardContent>
</Card>
```

For font installation, color-scheme changes, light/dark theming, or the `isolate` + negative-z-index gotcha, load the **`theming`** skill.

## Writing Tests vs. Running Tests

**Running the existing test script — always do it.** After any code change, run the project's test/validation script. **Your task is not complete until it passes.** The script typically covers TypeScript compilation, ESLint, and existing tests.

**Writing new test files — don't, unless the user asks.** If the user explicitly requests tests, describes a bug to diagnose with a test, or reports that a problem persists after a fix, load the **`testing`** skill for the project's Vitest + `TestApp` setup and policy.

## Validating Your Changes

**Your task is not finished until the code type-checks and builds without errors.** In priority order:

1. **Type check** (required)
2. **Build/compile** (required)
3. **Lint** (recommended; fix anything critical)
4. **Run tests** (if available)
5. **Git commit** (required)

### Using Git

Use `git status` / `git diff` to review changes and `git log` to learn project conventions.

**Multiple agents often work in this repository at the same time.** The working tree is shared, so at any moment it may contain other agents' in-flight changes — including files that don't yet type-check, compile, or make sense. Treat anything you didn't edit as someone else's live work:

- **Never run commands that touch files you didn't edit.** In particular **NEVER use `git stash`** (or `git stash pop`) — it rips every agent's uncommitted work out of the tree and interrupts them. Same for `git add -A` / `git add .`, `git reset`, `git checkout .`, `git clean`, and branch switches: they sweep up or destroy others' in-flight work.
- **Stage only your own files by name** (`git add path/to/file1 path/to/file2`) and commit just those. Don't attribute, fix, revert, or commit changes you didn't make — even if they look broken or unfinished.
- If you must undo one of *your own* edits, scope it to that exact file (`git checkout -- path/to/your/file`), never a whole directory or the tree.

**A red `npm test` may not be your fault.** Because another agent may have left the tree mid-edit, a full validation run can fail on files you never touched. Still run it, but also validate your files in isolation (e.g. `npx eslint <your-file>`, or type-check and read the errors for *your* paths). If the only failures are in files you didn't edit, say so plainly and commit your scoped changes anyway — don't fix the other agent's work to force a green run.

**Always commit when you are finished.** Non-negotiable — every completed task ends with a commit of your own files. Don't wait for the user to ask.
