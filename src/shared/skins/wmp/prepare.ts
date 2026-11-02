import type { VmNode } from './protocol';
import type { WmsNode } from './wms';

/**
 * WMP's predefined elements (PLAYBUTTON, SEEKSLIDER, WMPEFFECTS, ...) as
 * the base element they are, with the attributes they come with. A skin's
 * own attributes win.
 */
const controlButton = (method: string, tip: string) => ({
  onclick: `jscript:player.controls.${method}()`,
  uptooltip: tip,
  cursor: 'system',
  enabled: `wmpenabled:player.controls.${method}`,
});

const PREDEFINED: Record<string, [string, Record<string, string>]> = {
  playbutton: ['button', controlButton('play', 'Play')],
  pausebutton: ['button', controlButton('pause', 'Pause')],
  stopbutton: ['button', controlButton('stop', 'Stop')],
  prevbutton: ['button', controlButton('previous', 'Previous')],
  nextbutton: ['button', controlButton('next', 'Next')],
  rewbutton: ['button', controlButton('fastReverse', 'Fast Reverse')],
  ffwdbutton: ['button', controlButton('fastForward', 'Fast Forward')],
  mutebutton: ['button', { onclick: 'jscript:player.settings.mute=down;', uptooltip: 'Mute', downtooltip: 'Sound', down: 'wmpprop:player.settings.mute', sticky: 'true' }],
  repeatbutton: ['button', { onclick: "jscript:player.settings.setMode('loop',down);", uptooltip: 'Turn Repeat On', downtooltip: 'Turn Repeat Off', down: "wmpprop:player.settings.getMode('loop')", sticky: 'true' }],
  shufflebutton: ['button', { onclick: "jscript:player.settings.setMode('shuffle',down);", uptooltip: 'Turn Shuffle On', downtooltip: 'Turn Shuffle Off', down: "wmpprop:player.settings.getMode('shuffle')", sticky: 'true' }],
  closebutton: ['button', { onclick: 'jscript:view.close();', uptooltip: 'Close' }],
  minimizebutton: ['button', { onclick: 'jscript:view.minimize();', uptooltip: 'Minimize' }],
  returnbutton: ['button', { onclick: 'jscript:view.returnToMediaCenter();', uptooltip: 'Return to Full Mode' }],
  imagebutton: ['button', { cursor: 'hand' }],
  playelement: ['buttonelement', controlButton('play', 'Play')],
  pauseelement: ['buttonelement', controlButton('pause', 'Pause')],
  stopelement: ['buttonelement', controlButton('stop', 'Stop')],
  prevelement: ['buttonelement', controlButton('previous', 'Previous')],
  nextelement: ['buttonelement', controlButton('next', 'Next')],
  rewelement: ['buttonelement', controlButton('fastReverse', 'Fast Reverse')],
  ffwdelement: ['buttonelement', controlButton('fastForward', 'Fast Forward')],
  seekslider: ['slider', {
    tooltip: 'Seek', min: '0', max: 'wmpprop:player.currentMedia.duration', value: 'wmpprop:player.controls.currentPosition',
    ondragend: 'jscript:player.controls.currentPosition=value;',
  }],
  volumeslider: ['slider', {
    tooltip: 'Volume', min: '0', max: '100', value: 'wmpprop:player.settings.volume',
    value_onchange: 'jscript:player.settings.volume=value; player.settings.mute=false;',
  }],
  balanceslider: ['slider', { tooltip: 'Balance', min: '-100', max: '100', value: 'wmpprop:player.settings.balance', value_onchange: 'jscript:player.settings.balance=value;' }],
  currentpositiontext: ['text', { value: 'wmpprop:player.controls.currentPositionString', justification: 'right' }],
  durationtext: ['text', { value: 'wmpprop:player.currentMedia.durationString', justification: 'right' }],
  statustext: ['text', { value: 'wmpprop:player.status' }],
  tracknametext: ['text', { value: 'wmpprop:player.currentMedia.name' }],
  wmpeffects: ['effects', { horizontalalignment: 'stretch', verticalalignment: 'stretch', height: '200', width: '250', tabstop: 'false', onclick: 'next();' }],
  wmpvideo: ['video', { backgroundcolor: 'black', horizontalalignment: 'stretch', verticalalignment: 'stretch' }],
  dropdownplaylist: ['playlist', { playlistitemsvisible: 'false' }],
  itemsplaylist: ['playlist', { backgroundcolor: 'black', foregroundcolor: 'white', columns: 'name=Name;Duration=Time', columnsvisible: 'false', dropdownvisible: 'false' }],
};

/** Give every element an internal id and expand predefined ones. */
export function prepareView(view: WmsNode): VmNode {
  let next = 0;
  const walk = (node: WmsNode): VmNode => {
    const pre = PREDEFINED[node.tag];
    const tag = pre ? pre[0] : node.tag;
    const attrs = pre ? { ...pre[1], ...node.attrs } : { ...node.attrs };
    return { iid: `e${next++}`, tag, originalTag: node.tag, attrs, children: node.children.map(walk) };
  };
  return walk(view);
}

/** The views of a theme, by id (the first is the one shown at load). */
export function themeViews(theme: WmsNode): WmsNode[] {
  return theme.children.filter((c) => c.tag === 'view');
}
