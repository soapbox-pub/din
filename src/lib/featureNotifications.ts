/**
 * Install buttons on the desktop's notifications, for what can't work for
 * want of an optional feature (a Windows program with no Wine, a phone with
 * no way to open it, dictation): the caller names the feature what failed
 * needs, and Install installs it from the notification, its progress in a
 * notification of its own. Nothing is added where it's installed (so the
 * failure was something else) or Din can't install it here.
 */
import { canInstallFeature, cleanFeaturesError, findFeature, getFeaturesBridge, type FeatureState } from '@/lib/features';
import { notify, updateNotificationByKey, type NotifyInput } from '@/lib/notificationCenter';
import type { Toast } from '@/hooks/useToast';

const INSTALL = 'install-feature';
const SOURCE = { name: 'Optional Features' };

/** A feature, if Din can install it here and hasn't. */
async function installable(id: string | null | undefined): Promise<FeatureState | null> {
  const bridge = getFeaturesBridge();
  if (!id || !bridge) return null;
  const state = await bridge.state().catch(() => undefined);
  const feature = findFeature(state, id);
  return canInstallFeature(state, feature) ? feature : null;
}

/** Install a feature, saying how it's going in a notification. */
export function installFeature(feature: Pick<FeatureState, 'id' | 'title'>, onInstalled?: () => void): void {
  const bridge = getFeaturesBridge();
  if (!bridge) return;
  const replaceKey = `feature-install:${feature.id}`;
  notify({ source: SOURCE, title: `Installing ${feature.title}…`, progress: null, timeout: 0, resident: true, replaceKey });
  let finished = false;
  // Already being installed (from Settings, or another notification): this follows that one.
  let following = false;
  const finish = (installed: boolean, error?: unknown) => {
    if (finished) return;
    finished = true;
    stop();
    if (installed) {
      notify({ source: SOURCE, title: `${feature.title} is installed`, replaceKey });
      onInstalled?.();
    } else {
      notify({ source: SOURCE, title: `Couldn’t install ${feature.title}`, body: cleanFeaturesError(error), replaceKey });
    }
  };
  const stop = bridge.onChanged((state) => {
    const now = findFeature(state, feature.id);
    if (now?.busy?.action === 'install') updateNotificationByKey(replaceKey, { progress: now.busy.progress });
    else if (following && now && !now.busy) finish(now.installed, now.error ?? 'It didn’t install.');
  });
  bridge.install(feature.id).then(
    () => finish(true),
    (error: unknown) => {
      void bridge.state().then(
        (state) => {
          const now = findFeature(state, feature.id);
          if (now?.busy?.action === 'install') following = true;
          else finish(now?.installed ?? false, error);
        },
        () => finish(false, error),
      );
    },
  );
}

/** A notification's Install action for a feature, and what picking it does, or null. */
async function featureActions(
  id: string | null | undefined,
  onInstalled?: () => void,
): Promise<{ actions: { id: string; label: string }[]; onAction: (action: string) => boolean } | null> {
  const feature = await installable(id);
  if (!feature) return null;
  return {
    actions: [{ id: INSTALL, label: `Install ${feature.title}` }],
    onAction: (action) => {
      if (action !== INSTALL) return false;
      installFeature(feature, onInstalled);
      return true;
    },
  };
}

/** Notify, with an Install button for `feature` where Din can install it here and hasn't. */
export async function notifyWithFeature(input: NotifyInput, feature: string | null | undefined, onInstalled?: () => void): Promise<void> {
  const install = await featureActions(feature, onInstalled);
  if (!install) {
    notify(input);
    return;
  }
  notify({
    ...input,
    actions: [...install.actions, ...(input.actions ?? [])],
    onActivate: (action) => {
      if (!install.onAction(action)) input.onActivate?.(action);
    },
  });
}

/** A toast (useToast's), with an Install button for `feature` where Din can install it here and hasn't. */
export async function toastWithFeature(show: (toast: Toast) => unknown, toast: Toast, feature: string | null | undefined): Promise<void> {
  const install = await featureActions(feature);
  show(install ? { ...toast, actions: [...install.actions, ...(toast.actions ?? [])], onAction: (a) => install.onAction(a) || toast.onAction?.(a) } : toast);
}
