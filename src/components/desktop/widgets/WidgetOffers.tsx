import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useWidgets } from '@/contexts/WidgetsContext';
import { getLaunchBridge } from '@/lib/launchedApps';
import {
  declaredDomains,
  getWidgetsBridge,
  isPermissionDomain,
  parseFileWidget,
  type FileSource,
  type PermissionDomain,
  type WidgetSize,
} from '@/lib/widgets';
import { PermissionScreen } from './WidgetGallery';

interface Offer {
  offerId: string;
  source: FileSource;
  size?: WidgetSize;
}

const SIZES: readonly string[] = ['small', 'medium', 'large'];

/**
 * Folders' widgets `din widgets add-folder` offers (electron/din-launch.mts):
 * one that asks for no permissions goes straight on the desktop, and any
 * other waits on its permission screen, as in Add Widgets, for the user to
 * add it or not. The command hears which.
 */
export function WidgetOffers() {
  const { widgets, add } = useWidgets();
  const [offers, setOffers] = useState<Offer[]>([]);
  const live = useRef({ widgets, add, offers });
  useLayoutEffect(() => {
    live.current = { widgets, add, offers };
  });

  useEffect(() => {
    const bridge = getLaunchBridge();
    const widgetsBridge = getWidgetsBridge();
    if (!bridge?.onWidget || !widgetsBridge) return;
    const offOffer = bridge.onWidget(async (raw) => {
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { offerId?: unknown; path?: unknown; size?: unknown };
      if (typeof r.offerId !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/')) return;
      const offerId = r.offerId;
      const size = typeof r.size === 'string' && SIZES.includes(r.size) ? (r.size as WidgetSize) : undefined;
      let source: FileSource;
      try {
        source = parseFileWidget(await widgetsBridge.folder(r.path));
      } catch (error) {
        const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
        void bridge.widgetAnswer(offerId, 'failed', message);
        return;
      }
      const { widgets, add } = live.current;
      if (widgets.some((w) => w.source.type === 'file' && w.source.path === source.path)) {
        void bridge.widgetAnswer(offerId, 'failed', `${source.title} is already on the desktop, and reloads whenever its files change`);
        return;
      }
      if (!declaredDomains(source).some(isPermissionDomain)) {
        add(source, { size });
        void bridge.widgetAnswer(offerId, 'added');
        return;
      }
      setOffers((list) => [...list, { offerId, source, size }]);
      void bridge.widgetAnswer(offerId, 'asking');
    });
    const offCancel = bridge.onWidgetCancel((offerId) => setOffers((list) => list.filter((o) => o.offerId !== offerId)));
    return () => {
      offOffer();
      offCancel();
      // Signed out: nobody's there to answer.
      for (const o of live.current.offers) void bridge.widgetAnswer(o.offerId, 'failed', 'Din’s desktop closed');
      setOffers([]);
    };
  }, []);

  const offer = offers[0];
  const settle = (denied: PermissionDomain[] | null) => {
    if (!offer) return;
    setOffers((list) => list.filter((o) => o.offerId !== offer.offerId));
    if (denied) add(offer.source, { size: offer.size, denied });
    void getLaunchBridge()?.widgetAnswer(offer.offerId, denied ? 'added' : 'failed', denied ? undefined : 'You chose not to add it');
  };

  return (
    <Dialog open={!!offer} onOpenChange={(open) => !open && settle(null)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Add a widget</DialogTitle>
        <DialogDescription className="sr-only">A widget from a folder on this computer asks to go on your desktop.</DialogDescription>
        {offer && (
          <PermissionScreen
            key={offer.offerId}
            source={offer.source}
            onCancel={() => settle(null)}
            onAdd={(denied) => settle(denied)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
