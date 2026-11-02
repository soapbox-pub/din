import { useState } from 'react';
import { ArrowLeft, Puzzle, RefreshCw, Search } from 'lucide-react';
import { PackageStore } from '@/components/desktop/apps/appstore/PackageStore';
import { InstalledExtensions, type InstalledExtensionsProps } from '@/components/desktop/apps/InstalledExtensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useExtensionCatalog } from '@/hooks/useThemePackages';
import { parsePackageNaddr, type PackageAddress } from '@/lib/themePackages';
import { cn } from '@/lib/utils';

export interface ExtensionsPageProps {
  /** The extension whose page to open on, from a `nostr:` link to one. */
  initial: PackageAddress | null;
  /** What managing the installed ones needs from the browser window. */
  installed: Omit<InstalledExtensionsProps, 'onViewPublished'>;
}

/**
 * about:extensions: the browser's extensions in one place. At the top, the
 * installed ones, to reload, publish or remove, with ways to add one from a
 * folder, a .crx file or the Chrome Web Store, and the userscripts
 * (InstalledExtensions); below, browser extensions published to Nostr
 * (NIP-82 apps with a .crx) by Din's publishers, the people the user
 * follows, and the user, to find and get, laid out like the App Store's
 * Cursors, Icons and Skins (PackageStore), which these aren't listed among.
 * An internal page, painted over the tab's parked surface like
 * about:preferences (src/lib/internalPages.ts).
 */
export function ExtensionsPage({ initial, installed }: ExtensionsPageProps) {
  const catalog = useExtensionCatalog();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PackageAddress | null>(initial);

  return (
    // Opaque, like the settings page: the surface underneath is a white
    // about:blank.
    <div className="absolute inset-0 flex flex-col bg-background bg-gradient-to-b from-background to-muted/30 text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
        {selected ? (
          <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="Back to all extensions" title="Back">
            <ArrowLeft aria-hidden />
          </Button>
        ) : (
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <Puzzle className="size-5" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Extensions</h1>
          <p className="truncate text-sm text-muted-foreground">Yours, and ones people you follow published on Nostr</p>
        </div>
        {!selected && (
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search extensions, or paste an address"
              aria-label="Search extensions"
              className="pl-9"
            />
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void catalog.refresh()}
          disabled={catalog.refreshing}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className={cn(catalog.refreshing && 'motion-safe:animate-spin')} aria-hidden />
        </Button>
      </header>
      <PackageStore
        type="extension"
        catalog={catalog}
        search={search}
        selected={selected}
        onSelect={setSelected}
        top={
          <InstalledExtensions
            {...installed}
            onViewPublished={(naddr) => setSelected(parsePackageNaddr(naddr, 'extension'))}
          />
        }
      />
    </div>
  );
}
