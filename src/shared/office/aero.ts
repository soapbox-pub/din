/**
 * The Windows 7 finish over Office's modern layout: two-tone gloss split at
 * the middle, Office 2010's golden hover on ribbon controls, Aero command
 * buttons and Explorer's pale blue selection. OfficeFrame mounts it; the
 * classes are global so menus portaled out of the frame, and the window
 * title bar the apps draw into, get them too.
 */
export const AERO_CSS = `
.office-hover:not(:disabled):hover,
.office-hover[data-highlighted]:not([data-disabled]),
.office-hover[data-state='open'] {
  background: linear-gradient(#fffcf0, #fff0c3 48%, #ffe38f 52%, #fff1c6);
  box-shadow: inset 0 0 0 1px #f0c75c;
}
.office-hover:not(:disabled):active,
.office-on,
.office-on:not(:disabled):hover {
  background: linear-gradient(#fde2a6, #fcd185 48%, #fbbf5a 52%, #fcd893);
  box-shadow: inset 0 0 0 1px #c9a24d, inset 0 1px 2px rgba(120, 80, 0, 0.18);
}

.office-gloss {
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
  background: linear-gradient(
    color-mix(in srgb, var(--office-accent) 60%, #fff),
    color-mix(in srgb, var(--office-accent) 85%, #fff) 48%,
    var(--office-accent) 52%,
    color-mix(in srgb, var(--office-accent) 80%, #fff)
  );
  box-shadow: inset 0 0 0 1px var(--office-accent-dark), inset 0 0 0 2px rgba(255, 255, 255, 0.22);
}
.office-gloss:hover { filter: brightness(1.08); }

.office-glass:not(:disabled):hover {
  background: linear-gradient(rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.2) 48%, rgba(255, 255, 255, 0.06) 52%, rgba(255, 255, 255, 0.24));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5), 0 0 6px rgba(255, 255, 255, 0.3);
}
.office-glass:not(:disabled):active {
  background: rgba(0, 0, 0, 0.16);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35), inset 0 1px 3px rgba(0, 0, 0, 0.3);
}

.office-orb {
  color: #fff;
  border-radius: 9999px;
  background:
    radial-gradient(ellipse 70% 45% at 50% 22%, rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0) 70%),
    radial-gradient(circle at 50% 85%, color-mix(in srgb, var(--office-accent) 55%, #9ff), var(--office-accent) 65%);
  box-shadow: inset 0 0 0 1px var(--office-accent-dark), 0 1px 2px rgba(0, 0, 0, 0.3);
}
.office-orb:hover { filter: brightness(1.12) saturate(1.1); }
.office-orb:active { filter: brightness(0.92); }

.office-button {
  color: #000;
  border: 1px solid #707070;
  border-radius: 3px;
  background: linear-gradient(#f2f2f2, #ebebeb 48%, #dddddd 52%, #cfcfcf);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.7);
}
.office-button.office-default { border-color: #3c7fb1; box-shadow: inset 0 0 0 1px #a6d8f5; }
.office-button:not(:disabled):hover {
  border-color: #3c7fb1;
  background: linear-gradient(#eaf6fd, #d9f0fc 48%, #bee6fd 52%, #a7d9f5);
}
.office-button:not(:disabled):active {
  border-color: #2c628b;
  background: linear-gradient(#e5f4fc, #c4e5f6 48%, #98d1ef 52%, #68b3db);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
}

.office-select:hover {
  background: linear-gradient(#f5fafe, #e5f1fc);
  box-shadow: inset 0 0 0 1px #b8d6fb;
}
.office-select:active {
  background: linear-gradient(#e0eefc, #c2dcfd);
  box-shadow: inset 0 0 0 1px #7da2ce;
}

.office-tabs { background: linear-gradient(#eef3f9, #dfe7f2); box-shadow: inset 0 -1px 0 #b6c4d6; }
.office-ribbon { background: linear-gradient(#ffffff, #f8fafd 20%, #eef3fa 80%, #e4ebf5); border-bottom: 1px solid #b6c4d6; }
.office-status { background: linear-gradient(#e9eff7, #d6e1ef); border-top: 1px solid #b6c4d6; }
.office-backstage-nav { background: linear-gradient(to right, #fdfeff, #eaf0f8); border-right: 1px solid #b6c4d6; }
`;
