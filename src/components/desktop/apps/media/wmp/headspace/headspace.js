// Headspace: a head with a screen for a mind and speakers for ears.
// The left ear pulls out the equalizer, the right ear the playlist, and the
// starburst button lowers the visualization chooser over the screen.

var eqOpen = false;
var plOpen = false;
var visOpen = false;
var videoPlaying = false;

var EQ_CLOSED = 207, EQ_OPENED = 0;
var PL_CLOSED = 277, PL_OPENED = 488;
var VIS_CLOSED = 33, VIS_OPENED = 59;
var WIDTH_CLOSED = 549, WIDTH_OPENED = 760;
var SLIDE_MS = 120;

var TIPS = {
  eqOpen: 'Open graphic equalizer controls',
  eqClose: 'Close graphic equalizer controls',
  plOpen: 'Open playlist',
  plClose: 'Close playlist',
  visOpen: 'Open visualization chooser',
  visClose: 'Close visualization chooser'
};

function init() {
  playlist.setColumnResizeMode(0, 'stretch');
  playlist.setColumnResizeMode(1, 'autosizedata');

  // Pick up the visualization full mode last showed.
  var type = mediacenter.effectType;
  var preset = mediacenter.effectPreset;
  if (type) visEffects.currentEffectType = type;
  if (preset !== undefined && preset !== null && preset !== '') visEffects.currentPreset = preset;

  view.width = WIDTH_CLOSED;

  videoPlaying = isVideo();
  if (videoPlaying) startVideo();
  else endVideo();
}

function onClose() {
  mediacenter.effectType = visEffects.currentEffectType;
  mediacenter.effectPreset = visEffects.currentPreset;
}

function isVideo() {
  return player.openState == osMediaOpen && player.currentMedia.imageSourceWidth > 0;
}

// The player's media, open or play state changed: video starts or ends.
function checkVideo() {
  var video = isVideo();
  if (video && !videoPlaying) startVideo();
  else if (!video && videoPlaying) endVideo();
}

function startVideo() {
  videoPlaying = true;
  if (visOpen) {
    // visDropMoveEnd() comes back here once the bar is out of the way.
    toggleVis();
    return;
  }
  visEffects.visible = false;
  video.visible = true;
}

function endVideo() {
  visEffects.visible = true;
  video.visible = false;
  videoPlaying = false;
}

function setHandle(button, name) {
  button.image = name + '.png';
  button.hoverImage = name + '-hover.png';
  button.downImage = name + '-down.png';
}

function toggleEq() {
  if (!eqOpen) {
    eqPanel.visible = true;
    eqClose.visible = true;
    eqDrawer.moveTo(EQ_OPENED, eqDrawer.top, SLIDE_MS);
    setHandle(eqHandle, 'handle-left-close');
    eqHandle.upToolTip = TIPS.eqClose;
    eqToggle.upToolTip = TIPS.eqClose;
  } else {
    eqDrawer.moveTo(EQ_CLOSED, eqDrawer.top, SLIDE_MS);
    setHandle(eqHandle, 'handle-left-open');
    eqHandle.upToolTip = TIPS.eqOpen;
    eqToggle.upToolTip = TIPS.eqOpen;
  }
  eqOpen = !eqOpen;
}

function eqMoveEnd() {
  eqPanel.visible = eqOpen;
  eqClose.visible = eqOpen;
}

function togglePl() {
  if (!plOpen) {
    view.width = WIDTH_OPENED;
    plClose.visible = true;
    plDrawer.moveTo(PL_OPENED, plDrawer.top, SLIDE_MS);
    setHandle(plHandle, 'handle-right-close');
    plHandle.upToolTip = TIPS.plClose;
    plToggle.upToolTip = TIPS.plClose;
  } else {
    playlist.visible = false;
    plDrawer.moveTo(PL_CLOSED, plDrawer.top, SLIDE_MS);
    setHandle(plHandle, 'handle-right-open');
    plHandle.upToolTip = TIPS.plOpen;
    plToggle.upToolTip = TIPS.plOpen;
  }
  plOpen = !plOpen;
}

function plMoveEnd() {
  playlist.visible = plOpen;
  plClose.visible = plOpen;
  if (!plOpen) view.width = WIDTH_CLOSED;
}

function toggleVis() {
  if (visOpen) {
    visDrop.moveTo(visDrop.left, VIS_CLOSED, SLIDE_MS);
    visOpen = false;
    visButton.upToolTip = TIPS.visOpen;
  } else if (!videoPlaying) {
    visDrop.visible = true;
    visDrop.moveTo(visDrop.left, VIS_OPENED, SLIDE_MS);
    visOpen = true;
    visButton.upToolTip = TIPS.visClose;
  }
}

function visDropMoveEnd() {
  visDrop.visible = visOpen;
  if (videoPlaying) startVideo();
}
