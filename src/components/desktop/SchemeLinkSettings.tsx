import { AppIcon } from '@/shared/AppIcon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSchemeLinks } from '@/hooks/useSchemeLinks';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/** The Select's value for "ask every time". */
const ASK = 'ask';

/**
 * Where other schemes' links (`bitcoin:`, `monero:`, …) open, a row for
 * each scheme some app opens: the app chosen with "Always" in Open With, or
 * asking every time when more than one app opens them (with one, it opens
 * them). `din links default` does the same.
 */
export function SchemeLinkSettings() {
  const links = useSchemeLinks();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="px-1 text-sm font-semibold text-foreground/90">Other links</h3>
        <p className="px-1 text-xs text-muted-foreground">
          Where bitcoin:, monero: and other links open. Apps that open them say so in their web app manifest.
        </p>
      </div>

      <div className={settingsGroup}>
        {links.schemes.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No app on this computer opens any.</p>
        ) : (
          links.schemes.map((scheme) => <SchemeRow key={scheme} scheme={scheme} links={links} />)
        )}
      </div>
    </div>
  );
}

function SchemeRow({ scheme, links }: { scheme: string; links: ReturnType<typeof useSchemeLinks> }) {
  const { handlersFor, defaultFor, setDefault } = links;
  const handlers = handlersFor(scheme);
  const defaultApp = defaultFor(scheme);

  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-sm text-foreground">{scheme}:</span>
        <span className="block text-xs text-muted-foreground">
          {handlers.length <= 1
            ? `${handlers[0]?.name ?? 'No app'} is the only app that opens them.`
            : defaultApp
              ? `Every ${scheme}: link opens in ${defaultApp.name}.`
              : 'A link asks which app to use, with Just once or Always.'}
        </span>
      </span>
      {handlers.length > 1 && (
        <Select value={defaultApp?.id ?? ASK} onValueChange={(id) => setDefault(scheme, id === ASK ? null : id)}>
          <SelectTrigger size="sm" className="w-44" aria-label={`The app ${scheme}: links open in`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ASK}>Ask every time</SelectItem>
            {handlers.map((app) => (
              <SelectItem key={app.id} value={app.id}>
                <AppIcon icon={app.icon} web={app.web} className="size-5 shrink-0 rounded" />
                <span className="truncate">{app.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
