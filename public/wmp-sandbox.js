// The skin script sandbox's loader (see wmp-sandbox.html): run the runtime
// Din sends first, then get out of the way.
addEventListener('message', function boot(e) {
  if (e.source !== parent || !e.data || e.data.type !== 'runtime') return;
  removeEventListener('message', boot);
  (0, eval)(e.data.source);
});
parent.postMessage({ type: 'loaded' }, '*');
