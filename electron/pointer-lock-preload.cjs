// @ts-check
// Session preload for web pages and built-in apps that tells main when a
// frame takes or lets go of the pointer (DOM Pointer Lock), the way a
// first-person game does for mouse-look.
//
// Main forwards the pointer's moves inside a page to the desktop
// (forwardGuestInput in main.mts), with where the pointer is on screen.
// While a page holds the lock, Chromium on Wayland makes that position up
// by adding up the mouse's relative motion, without bound, so a player
// looking down would carry it past the screen's bottom edge and bring up
// the Dock. Main drops a page's moves while it holds the lock.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame: a game in an iframe
// locks the pointer from its own document, which its parent never hears of.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer } = require('electron');

let locked = false;
document.addEventListener('pointerlockchange', () => {
  const now = document.pointerLockElement !== null;
  if (now === locked) return;
  locked = now;
  ipcRenderer.send('guest:pointer-lock', now);
});
