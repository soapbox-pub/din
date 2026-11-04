# Din's own builds, shared by DinOS (configuration.nix) and the desktop
# module for other NixOS systems (desktop-module.nix): the app (the
# pages and the Electron host), the compositors, din-fd, and the Electron
# it all runs on.
{ pkgs, lib, din, electron }:

let
  # The Din source tree (the repo root, via the flake's `din` input),
  # narrowed to just what the Vite/Electron build needs. The whitelist
  # keeps node_modules, dist, os/, VM disks, etc. out of the store.
  # `/. + toString din` normalizes the path (the input arrives as
  # `<flake>/os/..`, which would defeat the prefix match below). The
  # string context must be dropped for the append; cleanSourceWith
  # re-imports the tree, so no store reference is lost.
  din-root = /. + builtins.unsafeDiscardStringContext (toString din);
  din-src = lib.cleanSourceWith {
    name = "din-source";
    src = din-root;
    filter = path: _type:
      let
        rel = lib.removePrefix (toString din-root + "/") (toString path);
        top = builtins.head (lib.splitString "/" rel);
      in
      builtins.elem top [
        "package.json"
        "package-lock.json"
        "index.html"
        "vite.config.ts"
        "tsconfig.json"
        "components.json"
        "public"
        "src"
        "electron"
      ]
      # The ad blocker's engine bundle is built from these two
      # (electron/adblock.mts), the Electron host is compiled by
      # build-electron.mjs, and the cursor converter (electron/cursorConverter.mts)
      # is bundled by build-cursor-converter.mjs, and window.din's runtime into
      # the app preload (and the caret finder into power mode's) by
      # build-din-runtime.mjs, and the built-in widgets by
      # build-widgets.mjs; runtime-deps.mjs lists Electron main's runtime
      # modules (below). `scripts` itself must pass for its files to.
      || rel == "scripts"
      || rel == "scripts/build-electron.mjs"
      || rel == "scripts/build-adblock-engine.mjs"
      || rel == "scripts/adblock-engine-entry.js"
      || rel == "scripts/build-cursor-converter.mjs"
      || rel == "scripts/build-din-runtime.mjs"
      || rel == "scripts/build-widgets.mjs"
      || rel == "scripts/runtime-deps.mjs";
  };

  # Build the Vite/React desktop environment from source (deps fetched via
  # lockfile hash).
  din-app = pkgs.buildNpmPackage {
    pname = "din";
    version = "0.1.0";
    src = din-src;
    npmDepsHash = "sha256-ISh0FK7PNU4fFei8cHqWLLTu45nMxUwgqUCionO0ZIs=";

    # The electron npm package (used by `npm run dev` on dev machines) tries
    # to download its binary in a postinstall hook; the VM uses nixpkgs
    # Electron instead, and there's no network in the build sandbox anyway.
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

    # The package.json scripts run `npm i` (network); run vite directly instead.
    buildPhase = ''
      runHook preBuild
      npm exec -- vite build -l error
      node scripts/build-electron.mjs
      node scripts/build-adblock-engine.mjs
      node scripts/build-cursor-converter.mjs
      node scripts/build-din-runtime.mjs
      node scripts/build-widgets.mjs
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/din
      cp -r dist $out/share/din/dist
      # The whole Electron host: main.mjs and the modules and workers it
      # loads (compiled from the .mts sources above, so no process pays for
      # Node's TypeScript stripper), the .cjs preloads, and the pty helper.
      # Copied wholesale so a new module can't be forgotten here.
      install -m444 electron/*.mjs electron/*.cjs $out/share/din/
      # The cursor converter's sandboxed page, bundled above.
      install -m444 electron/cursor-converter.js $out/share/din/cursor-converter.js
      install -m555 electron/pty-host.py $out/share/din/pty-host.py
      install -m555 electron/quickshare-bt.py $out/share/din/quickshare-bt.py
      # Publisher's INDD reader (electron/indd.mts), committed prebuilt.
      install -m444 electron/indd.wasm $out/share/din/indd.wasm
      # The ad blocker's extension, with its engine bundle built above.
      cp -r electron/adblock-extension $out/share/din/adblock-extension

      # package.json's dependencies, which are what Electron main loads
      # (`npm test` checks it), and theirs; Vite bundled the rest. Beside
      # main.mjs, which resolves them from there. Not `npm prune
      # --omit=dev`: it keeps peers too, which here are the electron
      # package (Electron provides its own) and TypeScript.
      for dir in $(node scripts/runtime-deps.mjs); do
        mkdir -p "$(dirname $out/share/din/$dir)"
        cp -rT $dir $out/share/din/$dir
      done
      runHook postInstall
    '';
  };

  # The Rust half of Din's embedded display (README, "Native Linux apps"):
  # one crate per derivation, each built from its own directory with any
  # local cargo output left out.
  native-src = crate: lib.cleanSourceWith {
    name = "${crate}-source";
    src = din-root + "/native/${crate}";
    filter = path: _type: baseNameOf path != "target";
  };

  # Din's Wayland compositors: the screen's (`din-compositor session`, which
  # Din runs under; see configuration.nix's din-shell) and the headless one native apps
  # run on. The screen's takes its seat through libseat (logind), its
  # displays and input from udev and libinput. libEGL is dlopen()ed rather
  # than linked, so glvnd goes on its rpath; glvnd finds the real driver
  # under /run/opengl-driver (hardware.graphics).
  din-compositor = pkgs.rustPlatform.buildRustPackage {
    pname = "din-compositor";
    version = "0.1.0";
    src = native-src "din-compositor";
    cargoLock.lockFile = din-root + "/native/din-compositor/Cargo.lock";
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = with pkgs; [ libgbm libdrm pixman libxkbcommon libinput seatd systemdLibs ];
    postFixup = ''
      patchelf --add-rpath ${pkgs.libglvnd}/lib $out/bin/din-compositor
    '';
  };

  # The N-API addon that hands the compositor's GPU buffers to Electron.
  din-fd = pkgs.rustPlatform.buildRustPackage {
    pname = "din-fd";
    version = "0.1.0";
    src = native-src "din-fd";
    cargoLock.lockFile = din-root + "/native/din-fd/Cargo.lock";
  };

  # The Electron Din runs on, with its main process closed to debuggers: a
  # SIGUSR1 from anything `din` runs would otherwise start Node's inspector
  # in it, and with that run code in Din's main process, which sudo trusts
  # to approve commands (os/din-password.py). Electron's
  # EnableNodeCliInspectArguments fuse turns off that and --inspect alike.
  # Fuses are bytes in the binary after a sentinel, so only the binary is
  # copied and changed; the rest of the build is linked, and the wrapper
  # points at the copy.
  electron-hardened = pkgs.runCommand "electron-hardened-${electron.version}" { } ''
    real=$(readlink -f ${electron}/libexec/electron/electron)
    mkdir -p $out/bin $out/libexec/electron
    for f in "$(dirname "$real")"/*; do
      ln -s "$f" $out/libexec/electron/
    done
    rm $out/libexec/electron/electron
    ${pkgs.python3}/bin/python3 - "$real" $out/libexec/electron/electron <<'EOF'
    import sys
    data = bytearray(open(sys.argv[1], "rb").read())
    sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
    at = data.find(sentinel)
    assert at >= 0 and data.find(sentinel, at + 1) < 0, "Electron's fuses aren't where they're expected"
    fuses = at + len(sentinel)
    assert data[fuses] == 1 and data[fuses + 1] > 3, "Electron's fuses have changed shape"
    inspect = fuses + 2 + 3  # EnableNodeCliInspectArguments
    assert data[inspect] in b"01", "Electron's inspector fuse is gone"
    data[inspect] = ord("0")
    open(sys.argv[2], "wb").write(data)
    EOF
    chmod 555 $out/libexec/electron/electron
    sed "s|$real|$out/libexec/electron/electron|g" ${electron}/bin/electron > $out/bin/electron
    grep -q "$out/libexec/electron/electron" $out/bin/electron
    chmod 555 $out/bin/electron
  '';

  # polkit's authentication agent for Din's session (see the script, and
  # electron/polkit-agent.mts): GLib's D-Bus and polkit's PolkitAgent.Session,
  # which runs polkit-agent-helper-1 to check the password.
  din-polkit-agent = pkgs.writeShellApplication {
    name = "din-polkit-agent";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pygobject3 ])) pkgs.systemd ];
    text = ''
      export GI_TYPELIB_PATH=${pkgs.polkit.out}/lib/girepository-1.0:${pkgs.glib.out}/lib/girepository-1.0
      exec python3 -I ${./din-polkit-agent.py} "$@"
    '';
  };
in
{
  inherit din-app din-compositor din-fd electron-hardened din-polkit-agent;
}
