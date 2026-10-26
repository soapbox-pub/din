{ config, pkgs, lib, din, deckmon, ... }:

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
      # (electron/adblock.mts), and the Electron host is compiled by
      # build-electron.mjs. `scripts` itself must pass for its files to.
      || rel == "scripts"
      || rel == "scripts/build-electron.mjs"
      || rel == "scripts/build-adblock-engine.mjs"
      || rel == "scripts/adblock-engine-entry.js";
  };

  # The release this system is (os/version), which a release's tag repeats
  # (scripts/dinos-release.sh). The updater compares it with the newest
  # release's. Not package.json's: the lockfile repeats that one, and
  # changing it changes npmDepsHash.
  version = lib.fileContents ./version;

  # Build the Vite/React desktop environment from source (deps fetched via
  # lockfile hash).
  din-app = pkgs.buildNpmPackage {
    pname = "din";
    version = "0.1.0";
    src = din-src;
    npmDepsHash = "sha256-niAPnoZFYP6eRp/OEYm7rmp4KclCJcz36SZUNuuWk5E=";

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
      install -m555 electron/pty-host.py $out/share/din/pty-host.py
      # Publisher's INDD reader (electron/indd.mts), committed prebuilt.
      install -m444 electron/indd.wasm $out/share/din/indd.wasm
      # The ad blocker's extension, with its engine bundle built above.
      cp -r electron/adblock-extension $out/share/din/adblock-extension

      # Runtime node modules for main.mts's Chrome extension support
      # (electron-chrome-extensions + electron-chrome-web-store and their
      # transitive runtime deps). Resolved relative to main.mts, so they
      # live in a node_modules directory beside it.
      mkdir -p $out/share/din/node_modules
      # The ad blocker's filter engine (electron/adblock.mts) and its
      # page preload come along too, and nostr-tools for Din's NIP-46
      # remote signer (electron/bunker.mts).
      for dep in nostr-tools @noble/ciphers @noble/curves @noble/hashes @scure/base \
        electron-chrome-extensions electron-chrome-web-store electron-chrome-context-menu debug ms adm-zip pbf \
        @ghostery/adblocker @ghostery/adblocker-content @ghostery/adblocker-extended-selectors \
        @ghostery/adblocker-electron-preload @ghostery/url-parser tldts-experimental tldts-core \
        @remusao/guess-url-type @remusao/small @remusao/smaz @remusao/smaz-compress \
        @remusao/smaz-decompress @remusao/trie; do
        mkdir -p "$(dirname $out/share/din/node_modules/$dep)"
        cp -r node_modules/$dep $out/share/din/node_modules/$dep
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

  # The headless Wayland compositor native apps run on. libEGL is dlopen()ed
  # rather than linked, so glvnd goes on its rpath; glvnd finds the real
  # driver under /run/opengl-driver (hardware.graphics).
  din-compositor = pkgs.rustPlatform.buildRustPackage {
    pname = "din-compositor";
    version = "0.1.0";
    src = native-src "din-compositor";
    cargoLock.lockFile = din-root + "/native/din-compositor/Cargo.lock";
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = with pkgs; [ libgbm libdrm pixman libxkbcommon ];
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

  # deckmon, the AirPlay sender behind screen sharing (electron/airplay.mts),
  # from its repository (the flake's `deckmon` input). It captures the screen
  # through cage's wlroots screencopy and encodes with GStreamer: VA-API on
  # the GPU, x264 or OpenH264 without one. pactl gives the receiver its sound
  # output, wlr-randr sets the size of the display it adds to extend the
  # desktop, and tee writes that display's EDID (through sudo, below).
  deckmon-gst = with pkgs.gst_all_1; [ gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly ];
  din-deckmon = pkgs.rustPlatform.buildRustPackage {
    pname = "deckmon";
    version = "0.2.0";
    src = deckmon + "/cli";
    cargoLock.lockFile = deckmon + "/cli/Cargo.lock";
    nativeBuildInputs = [ pkgs.pkg-config pkgs.makeWrapper ];
    buildInputs = (with pkgs.gst_all_1; [ gstreamer gst-plugins-base ]) ++ [ pkgs.libgbm ];
    postInstall = ''
      wrapProgram $out/bin/deckmon \
        --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : ${lib.makeSearchPath "lib/gstreamer-1.0" (map lib.getLib (deckmon-gst ++ [ pkgs.pipewire ]))} \
        --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils pkgs.pulseaudio pkgs.wlr-randr ]}
    '';
  };

  # Dictation's speech recognizer (electron/dictation.mts): whisper.cpp's
  # server, on the GPU through Vulkan, and Whisper large-v3-turbo quantized to
  # about 550 MB. The server is only started when someone dictates.
  whisper = pkgs.whisper-cpp-vulkan.override { withSDL = false; };
  whisper-model = pkgs.fetchurl {
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin";
    hash = "sha256-OUIhcJzVrR9AxG5gMcphvOiJMebgiMGIKUxtWlX/p+I=";
  };

  # The local UDP ports AirPlay receivers send timing and sound control to,
  # three per session; the firewall lets them in (below).
  airplayPorts = { from = 7010; to = 7039; };

  # Wine, for Windows programs (electron/windows-apps.mts). The WoW64 build
  # runs 32- and 64-bit programs without 32-bit host libraries. The Full
  # variant is the one that embeds the Wine Mono and Gecko installers (.NET
  # and the HTML engine), so a new prefix gets them with no download prompt.
  wine = pkgs.wineWow64Packages.stableFull;

  # The privileged half of the Installer app, which copies a live USB boot
  # onto the computer's own disk (see the script, and electron/installer.mts).
  din-installer = pkgs.writeShellApplication {
    name = "din-install";
    runtimeInputs = with pkgs; [
      coreutils util-linux gawk gnugrep gnused jq rsync dosfstools e2fsprogs
      efibootmgr systemd cryptsetup lvm2 openssl config.services.nostrd.package
    ];
    text = builtins.readFile ./din-install.sh;
  };

  # The privileged half of system updates, which stages newer releases for
  # the next boot (see the script, and electron/updater.mts).
  din-updater = pkgs.writeShellApplication {
    name = "din-update";
    runtimeInputs = with pkgs; [
      coreutils util-linux jq curl nak zstd gnutar config.nix.package
    ];
    text = builtins.readFile ./din-update.sh;
  };

  # The privileged half of Settings → Keyboard, which sets the system's
  # keyboard layout (see the script, and electron/keyboard.mts).
  din-keyboard = pkgs.writeShellApplication {
    name = "din-keyboard";
    runtimeInputs = with pkgs; [ coreutils gnugrep systemd libxkbcommon ckbcomp din-boot-screen ];
    text = builtins.readFile ./din-keyboard.sh;
  };

  # The privileged half of Settings → Date & Time, which sets the time zone
  # and the clock (see the script, and electron/datetime.mts).
  din-time = pkgs.writeShellApplication {
    name = "din-time";
    runtimeInputs = with pkgs; [ coreutils gnugrep systemd din-boot-screen ];
    text = builtins.readFile ./din-time.sh;
  };

  # Puts what the boot screen shows on the boot partition (see the script,
  # and electron/boot-screen.mts).
  din-boot-screen = pkgs.writeShellApplication {
    name = "din-boot-screen";
    runtimeInputs = with pkgs; [ coreutils util-linux ];
    text = builtins.readFile ./din-boot-screen.sh;
  };

  # The lock screen (see the script): the boot screen again, on its own
  # terminal, until the computer's password is typed.
  din-lock = pkgs.writeShellApplication {
    name = "din-lock";
    runtimeInputs = [ pkgs.python3 config.boot.plymouth.package config.systemd.package ];
    text = ''
      export DIN_LIBCRYPT=${pkgs.libxcrypt}/lib/libcrypt.so.2
      exec python3 ${./din-lock.py} "$@"
    '';
  };

  # Unlocks and re-keys `din`'s login keyring with the computer's password
  # (see the script).
  din-keyring = pkgs.writeShellApplication {
    name = "din-keyring";
    runtimeInputs = [ pkgs.python3 pkgs.util-linux pkgs.coreutils config.systemd.package ];
    text = ''
      exec python3 ${./din-keyring.py} "$@"
    '';
  };

  # Unlocks and re-keys `din`'s GPG keys with the computer's password (see the
  # script).
  din-gpg = pkgs.writeShellApplication {
    name = "din-gpg";
    runtimeInputs = [ pkgs.python3 pkgs.util-linux config.programs.gnupg.package ];
    text = ''
      exec python3 ${./din-gpg.py} "$@"
    '';
  };

  # Changes the computer's password: the disk's, nostrd's, the keyring's, the
  # GPG keys' and `din`'s together (see the script).
  din-password = pkgs.writeShellApplication {
    name = "din-password";
    runtimeInputs = with pkgs; [ python3 util-linux cryptsetup shadow ] ++ [ din-keyring din-gpg ];
    text = ''
      export DIN_LIBCRYPT=${pkgs.libxcrypt}/lib/libcrypt.so.2
      exec python3 ${./din-password.py} "$@"
    '';
  };

  # The boot and unlock screen: a Plymouth script theme (boot-screen/), with
  # the images it draws with made here. Its ImageDir is under /run, where
  # the initrd puts those and the user's wallpaper (dinos-boot-screen, below).
  boot-screen-theme = pkgs.runCommand "dinos-boot-screen" {
    nativeBuildInputs = [ pkgs.imagemagick pkgs.librsvg ];
  } ''
    dir=$out/share/plymouth/themes/din
    mkdir -p $dir
    cp ${./boot-screen/din.script} $dir/din.script
    cat >$dir/din.plymouth <<EOF
    [Plymouth Theme]
    Name=DinOS
    Description=Din's boot and unlock screen
    ModuleName=script

    [script]
    ImageDir=/run/din-boot
    ScriptFile=$dir/din.script
    EOF
    magick -size 1x1 xc:black $dir/black.png
    magick -size 640x96 xc:none -fill 'rgba(255,255,255,0.14)' \
      -stroke 'rgba(255,255,255,0.32)' -strokewidth 2 \
      -draw 'roundrectangle 1,1 638,94 47,47' $dir/field.png
    rsvg-convert -h 96 ${din-src}/public/din-logo.svg -o $dir/logo.png
  '';

  # Succeeds when the partition UUID given is the boot loader's ESP, from
  # systemd-boot's LoaderDevicePartUUID variable (UTF-16, after 4 bytes of
  # attributes).
  isBootedEsp = pkgs.writeShellScript "is-booted-esp" ''
    var=/sys/firmware/efi/efivars/LoaderDevicePartUUID-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f
    [ -r "$var" ] || exit 1
    loader=$(${pkgs.coreutils}/bin/tail -c +5 "$var" | ${pkgs.coreutils}/bin/tr -d '\0' | ${pkgs.coreutils}/bin/tr A-F a-f)
    [ -n "$1" ] && [ "$loader" = "$(echo "$1" | ${pkgs.coreutils}/bin/tr A-F a-f)" ]
  '';

  # Launcher: Electron running the Din host on Wayland (cage provides the
  # compositor), GPU-accelerated. `extraFlags` exists so the QEMU demo
  # variant below can swap in software rendering.
  # python3 must be on PATH for the Terminal app's pty host (pty-host.py),
  # nmcli for the Settings app's WiFi bridge, brightnessctl + gammastep for the
  # Settings/menu-bar brightness bridge (backlight + night light), wpctl
  # (wireplumber) for the Settings sound bridge's device/stream control and
  # pw-play (pipewire) for its test tone, pactl (pulseaudio's client, talking
  # to pipewire-pulse) for its change monitor and card profiles, wlr-randr
  # for the Settings display bridge's monitor arrangement (via cage),
  # Xwayland for X11 apps on the
  # embedded display native Linux apps run on (electron/native-display.mts)
  # and Xvfb for its fallback, setxkbmap plus xkeyboard-config's rules for
  # their keyboard layout (electron/keyboard.mts), gsettings (glib) for the
  # pointer's theme and size (electron/cursor.mts), Wine for Windows
  # programs, bsdtar (libarchive) plus gzip/xz/bzip2/zstd for the Files
  # app's archives (electron/files.mts), CUPS's tools and poppler's
  # pdftoppm/pdfinfo for printing and its previews (electron/printing.mts),
  # and sudo (from /run/wrappers) for
  # the Installer's, the updater's, the keyboard layout's, and the time
  # zone's helpers.
  makeDinLauncher = extraFlags: pkgs.writeShellScriptBin "din" ''
    export PATH=${pkgs.python3}/bin:${pkgs.networkmanager}/bin:${pkgs.brightnessctl}/bin:${pkgs.gammastep}/bin:${pkgs.wireplumber}/bin:${pkgs.pipewire}/bin:${pkgs.pulseaudio}/bin:${pkgs.wlr-randr}/bin:${pkgs.xwayland}/bin:${pkgs.xorg.xvfb}/bin:${pkgs.xorg.setxkbmap}/bin:${pkgs.glib.bin}/bin:${wine}/bin:${lib.makeBinPath [ pkgs.libarchive pkgs.gzip pkgs.xz pkgs.bzip2 pkgs.zstd config.services.printing.package pkgs.poppler-utils ]}:/run/wrappers/bin:$PATH
    export XKB_CONFIG_ROOT=${pkgs.xkeyboard_config}/share/X11/xkb
    export DIN_COMPOSITOR=${din-compositor}/bin/din-compositor
    export DIN_FD_ADDON=${din-fd}/lib/libdin_fd.so
    export DIN_INSTALLER=${din-installer}/bin/din-install
    export DIN_UPDATER=${din-updater}/bin/din-update
    export DIN_KEYBOARD=${din-keyboard}/bin/din-keyboard
    export DIN_BOOT_SCREEN=${din-boot-screen}/bin/din-boot-screen
    export DIN_TIME=${din-time}/bin/din-time
    export DIN_FWUPDMGR=${config.services.fwupd.package}/bin/fwupdmgr
    export DIN_LOCK=${din-lock}/bin/din-lock
    export DIN_PASSWORD=${din-password}/bin/din-password
    export DIN_DECKMON=${din-deckmon}/bin/deckmon
    export DIN_WHISPER_SERVER=${whisper}/bin/whisper-server
    export DIN_WHISPER_MODEL=${whisper-model}
    export DIN_AIRPLAY_PORTS=${toString airplayPorts.from}-${toString airplayPorts.to}
    export DIN_NOSTRD_SOCKET=/run/nostrd/signer.sock
    # Din is the whole desktop: the session's services (the desktop portal's
    # file chooser) open their windows on its embedded display
    # (electron/native-display.mts).
    export DIN_DESKTOP_SESSION=1
    # cage shows its newest window fullscreen with all the input, so anything
    # that opens a window on it takes Din's place, and there's no way back.
    # Wayland clients without a WAYLAND_DISPLAY look for wayland-0, which is
    # cage's; moving its socket aside leaves them failing to connect instead.
    # Only Din (and what it starts with its own environment, like wlr-randr
    # and gammastep) knows the new name. cage's lock file stays, so no other
    # compositor takes wayland-0 either.
    if [ -n "$WAYLAND_DISPLAY" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
      ${pkgs.coreutils}/bin/mv -f "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/din-shell"
      export WAYLAND_DISPLAY=din-shell
    fi
    # Chromium logging into the journal (via cage), for diagnosing real hardware.
    export ELECTRON_ENABLE_LOGGING=1
    # Chromium dlopens libva for hardware video decoding (VA-API), and
    # Electron's wrapper doesn't put it on the library path, so without this
    # every video is decoded on the CPU.
    export LD_LIBRARY_PATH=${pkgs.libva-minimal.out}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
    # Running from a USB stick (dinos-live, below), every fsync Chromium does
    # for its cookies and databases can hold it up for seconds, and the
    # desktop with it. There they're skipped: the writes still reach the
    # stick, a few seconds later.
    if [ -e /run/din/live ]; then
      export LD_PRELOAD=${pkgs.libeatmydata}/lib/libeatmydata.so''${LD_PRELOAD:+:$LD_PRELOAD}
    fi
    # pam_systemd gives the session's processes CAP_WAKE_ALARM as an ambient
    # capability (its default for a seat), which everything Din and its
    # Terminal start would inherit. Programs that drop all their capabilities
    # (gnome-keyring-daemon, for one) can't drop an ambient one they never
    # asked for, and abort. Terminals elsewhere are started by the user
    # manager and don't have it; nothing in Din needs it. pam_systemd has no
    # setting for "none" (an empty one means its default).
    exec ${pkgs.util-linux}/bin/setpriv --inh-caps=-all --ambient-caps=-all \
      ${pkgs.electron}/bin/electron \
      ${din-app}/share/din/main.mjs \
      --ozone-platform=wayland ${extraFlags}
  '';
  din-launcher = makeDinLauncher "";

  # Pointer themes for Settings → Appearance → Cursor (electron/cursor.mts).
  # Without any, Chromium and cage fall back to the tiny X11 arrow and
  # Chromium's own bitmaps, with no resize cursors at all. A `default` theme
  # points X11 apps and cage's own cursor at Capitaine, DinOS's default. Only a
  # few of each family are copied in: all of Bibata is over 300 MB.
  din-cursor-themes = pkgs.runCommand "din-cursor-themes" { } ''
    mkdir -p $out/share/icons/default
    cp -a ${pkgs.bibata-cursors}/share/icons/{Bibata-Modern-Classic,Bibata-Modern-Ice} $out/share/icons/
    cp -a ${pkgs.phinger-cursors}/share/icons/{phinger-cursors-light,phinger-cursors-dark} $out/share/icons/
    cp -a ${pkgs.capitaine-cursors}/share/icons/{capitaine-cursors,capitaine-cursors-white} $out/share/icons/
    printf '[Icon Theme]\nInherits=capitaine-cursors\n' > $out/share/icons/default/index.theme
  '';

  # cage creates the gamma-control protocol but never hands it to its scene,
  # so gamma ramps (night light's gammastep) are accepted and then silently
  # dropped. And it draws the pointer, until Din sets its own, from the
  # `default` theme at 24px whatever the user picked; patched, it takes
  # XCURSOR_THEME and XCURSOR_SIZE, which the wrapper reads from dconf (the
  # GSettings Din's Settings writes, electron/cursor.mts), so the pointer is
  # the same from the first frame. Din inherits them too.
  cage-patched = pkgs.cage.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      ./patches/cage-gamma-control.patch
      ./patches/cage-xcursor-env.patch
    ];
  });
  cage-launcher = pkgs.writeShellScriptBin "cage" ''
    key=/org/gnome/desktop/interface
    theme=$(${pkgs.dconf}/bin/dconf read $key/cursor-theme 2>/dev/null || true)
    theme=''${theme#\'}
    theme=''${theme%\'}
    size=$(${pkgs.dconf}/bin/dconf read $key/cursor-size 2>/dev/null || true)
    size=''${size##* }
    if [ -n "$theme" ]; then export XCURSOR_THEME="$theme"; fi
    case "$size" in
      ""|*[!0-9]*) ;;
      *) export XCURSOR_SIZE="$size" ;;
    esac
    exec ${cage-patched}/bin/cage "$@"
  '';
in
{
  networking.hostName = "dinos";

  # Which release this is, for the updater (os/din-update.sh), which reads it
  # from a system's etc/ - the running one's, and the next boot's.
  environment.etc."din-version".text = version;

  # NetworkManager backs Din's WiFi settings panel (nmcli via the
  # Electron wifi bridge). Physical adapters (wired and wireless) are
  # picked up by NetworkManager automatically.
  networking.networkmanager.enable = true;

  # udisks backs the USB sticks and SD cards Din mounts as they're plugged in
  # and ejects from Files (electron/volumes.mts), under /run/media/din. Din's
  # session has no seat, so udisks would ask for an admin password even for
  # removable media; this lets `din` mount, unmount and eject it without one.
  # Internal disks still need the password (filesystem-mount-system), and so
  # does unmounting anything Din didn't mount (filesystem-unmount-others):
  # that would include /boot and /home.
  services.udisks2.enable = true;
  security.polkit.extraConfig = ''
    polkit.addRule(function (action, subject) {
      if (subject.user != "din") return;
      var allowed = [
        "org.freedesktop.udisks2.filesystem-mount",
        "org.freedesktop.udisks2.filesystem-mount-other-seat",
        "org.freedesktop.udisks2.eject-media",
        "org.freedesktop.udisks2.eject-media-other-seat",
        "org.freedesktop.udisks2.power-off-drive",
        "org.freedesktop.udisks2.power-off-drive-other-seat",
      ];
      if (allowed.indexOf(action.id) >= 0) return polkit.Result.YES;
    });

    // fwupd, below.
    polkit.addRule(function (action, subject) {
      if (subject.user != "din") return;
      var allowed = [
        "org.freedesktop.fwupd.get-remotes",
        "org.freedesktop.fwupd.refresh-remote",
        "org.freedesktop.fwupd.update-internal-trusted",
        "org.freedesktop.fwupd.update-hotplug-trusted",
        "org.freedesktop.fwupd.clear-results",
      ];
      if (allowed.indexOf(action.id) >= 0) return polkit.Result.YES;
    });
  '';

  # Firmware updates from LVFS, for Settings → About (electron/firmware.mts):
  # the computer's own firmware (UEFI capsules, staged on /boot and applied
  # by the next restart) and its devices'. fwupd-refresh's timer keeps the
  # list of releases current. As with udisks, the seatless session would be
  # asked for an admin password; the polkit rule above lets `din` install
  # firmware that LVFS signed, and nothing else: local or unsigned files,
  # downgrades and fwupd's settings still need one. Secure Boot is off
  # wherever DinOS boots (its systemd-boot is unsigned), so fwupd's unsigned
  # EFI updater boots too.
  services.fwupd.enable = true;

  # Printing that needs no setup (electron/printing.mts). Avahi finds
  # printers on the network, ipp-usb puts USB printers that speak IPP (most
  # made since about 2015) there too, and CUPS lists both and makes a
  # driverless queue the first time one is used - so a printer shows up in
  # Din's print dialog as soon as it's on. Older USB printers need a driver;
  # Settings → Printers adds them with the best of gutenprint's and
  # brlaser's. `din` administers printers without a password because it's in
  # `wheel` (CUPS's SystemGroup). cups-browsed isn't needed for any of this
  # and has had remote holes, so it's off; nothing is shared. A printer that
  # can't be reached (asleep, off) keeps its job and tries again, rather than
  # CUPS's default of stopping the printer until someone starts it.
  services.printing = {
    enable = true;
    browsed.enable = false;
    drivers = [ pkgs.gutenprint pkgs.brlaser ];
    extraConf = ''
      ErrorPolicy retry-job
    '';
  };
  # CUPS ships a "Manage Printing" entry that opens its web admin page.
  # Settings → Printers is how Din manages printers, so keep it out of Apps.
  environment.extraSetup = ''
    rm -f $out/share/applications/cups.desktop
  '';
  services.ipp-usb.enable = true;
  services.avahi = {
    enable = true;
    nssmdns4 = true;
  };

  # The user Din runs as. `networkmanager` group membership lets the
  # WiFi settings panel control connections without polkit prompts; `video`
  # lets the brightness bridge write the backlight (via brightnessctl's udev
  # rules below) without root; `audio` grants access to the sound devices the
  # PipeWire sound bridge drives. `input` lets the Electron host read keyboard
  # event nodes directly for the laptop box-select screenshot key
  # (KEY_SELECTIVE_SCREENSHOT) and the mic-mute key (KEY_MICMUTE), whose
  # keysyms Chromium can't identify - see
  # electron/main.mts. The main process already observes every keystroke via
  # before-input-event; nothing new is exposed to renderers. `wheel` gives
  # the developer the machine: sudo, behind the computer's password.
  # The uid is pinned because this user used to be called `web`: installed
  # machines keep owning their home directory across the rename.
  users.users.din = {
    isNormalUser = true;
    uid = 1000;
    description = "Din desktop user";
    extraGroups = [ "wheel" "networkmanager" "video" "audio" "input" ];
    shell = pkgs.zsh;
  };

  # sudo asks for the computer's password: `din`'s, which the Installer sets
  # to the disk's when it encrypts (os/din-install.sh). Otherwise anything the
  # user runs could become root and read the keys out of nostrd. Din's own
  # helpers run without one; each takes only the commands it means to.
  #
  # Where `din` has no password - the live stick, an install without
  # encryption - there's nothing to ask for, so sudo doesn't: din-sudo puts a
  # rule saying so under /run at boot.
  #
  # /etc/sudoers.d is for the computer's own rules, as on other distros:
  # `sudo visudo -f /etc/sudoers.d/din` to stop asking on a developer's
  # machine.
  security.sudo.extraRules = [{
    users = [ "din" ];
    commands = map (command: { inherit command; options = [ "NOPASSWD" ]; }) [
      "${din-installer}/bin/din-install"
      "${din-updater}/bin/din-update"
      "${din-keyboard}/bin/din-keyboard"
      "${din-boot-screen}/bin/din-boot-screen"
      "${din-time}/bin/din-time"
      "${din-lock}/bin/din-lock start"
      "${din-lock}/bin/din-lock status"
      # It checks the old password itself.
      "${din-password}/bin/din-password change"
      # deckmon's virtual display for an AirPlay receiver, which extends the
      # desktop onto it: its EDID on the spare DisplayPort connector, forced
      # on, and taken away again.
      "${pkgs.coreutils}/bin/tee /sys/kernel/debug/dri/[0-9]*/DP-2/edid_override"
      "${pkgs.coreutils}/bin/tee /sys/kernel/debug/dri/[0-9]*/DP-2/trigger_hotplug"
      "${pkgs.coreutils}/bin/tee /sys/class/drm/card[0-9]*-DP-2/status"
      "${pkgs.coreutils}/bin/test -e /sys/kernel/debug/dri/[0-9]*/DP-2/trigger_hotplug"
    ];
  }];
  security.sudo.extraConfig = ''
    @includedir /run/din/sudoers.d
    @includedir /etc/sudoers.d
  '';
  systemd.tmpfiles.settings."10-din-sudo" = {
    "/run/din/sudoers.d".d = {
      mode = "0750";
      user = "root";
      group = "root";
    };
    "/etc/sudoers.d".d = {
      mode = "0750";
      user = "root";
      group = "root";
    };
  };
  systemd.services.din-sudo = {
    description = "Let sudo skip the password when din has none";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-tmpfiles-setup.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      rule=/run/din/sudoers.d/no-password
      hash=$(${pkgs.gawk}/bin/awk -F: '$1 == "din" { print $2 }' /etc/shadow)
      case $hash in
        "" | "!"* | "*"*)
          echo 'din ALL=(ALL:ALL) NOPASSWD: ALL' > "$rule.tmp"
          chmod 0440 "$rule.tmp"
          mv "$rule.tmp" "$rule"
          ;;
        *) rm -f "$rule" ;;
      esac
    '';
  };

  # nostrd, the signer daemon: it holds the Nostr account keys as its own
  # user, out of reach of everything `din` runs, and Din signs through it
  # (electron/nostrd.mts). Its password is the disk's (os/din-install.sh), so
  # the passphrase that unlocks the disk at boot unlocks it too.
  services.nostrd = {
    enable = true;
    users = [ "din" ];
    unlockWithDiskPassword = true;
  };

  # The login keyring (the Secret Service most Linux apps keep passwords and
  # tokens in), with the computer's password, as on any desktop. There's no
  # login screen for pam_gnome_keyring to take the password from, so it comes
  # from the boot screen like nostrd's: this reads the passphrase cached in
  # root's keyring and unlocks `din`'s keyring with it, creating it the first
  # time. nostrd-unlock, after it, removes the cached copy. Without a password
  # (the live stick, a plain disk) the keyring has none either. With one but
  # nothing cached, it stays locked until an app asks to unlock it.
  # din-password keeps the keyring's password in step with the others;
  # `din-keyring change` re-keys a keyring brought from another computer.
  services.gnome.gnome-keyring.enable = true;
  systemd.services.din-keyring-unlock = {
    description = "Unlock the login keyring with the disk passphrase";
    wantedBy = [ "multi-user.target" ];
    wants = [ "user@${toString config.users.users.din.uid}.service" ];
    after = [ "user@${toString config.users.users.din.uid}.service" ];
    before = [ "nostrd-unlock.service" ];
    path = [ pkgs.keyutils pkgs.gawk din-keyring ];
    serviceConfig = {
      Type = "oneshot";
      # See nostrd-unlock: reading the cached key takes root's user keyring.
      KeyringMode = "shared";
    };
    script = ''
      if id=$(keyctl search @u user cryptsetup 2>/dev/null); then
        keyctl pipe "$id" | din-keyring unlock || true
        exit 0
      fi
      hash=$(awk -F: '$1 == "din" { print $2 }' /etc/shadow)
      case $hash in
        "" | "!"* | "*"*) din-keyring unlock </dev/null || true ;;
      esac
    '';
  };

  # gpg, for signing commits. The passphrase prompt is a Qt window, which
  # opens on Din's desktop like any native app; a terminal prompt would never
  # reach anyone when git runs without a terminal, as coding agents do.
  # Keys whose passphrase is the computer's password don't ask at all: like
  # the keyring, they're unlocked at boot with the boot screen's passphrase
  # (os/din-gpg.py), and stay unlocked until gpg-agent stops.
  programs.gnupg.agent = {
    enable = true;
    pinentryPackage = pkgs.pinentry-qt;
    settings.allow-preset-passphrase = "";
    # gpg-agent forgets every passphrase this long after it's cached, preset
    # ones too: by default two hours, after which signing asked again. There's
    # no "never", so it's 2^32-1 seconds (136 years), and the boot's unlock
    # lasts until shutdown. Not ULONG_MAX: gpg-agent checks created + ttl <
    # now, which wraps and would expire everything at once. One typed in the
    # prompt still goes after 10 minutes unused (default-cache-ttl).
    settings.max-cache-ttl = 4294967295;
  };
  systemd.services.din-gpg-unlock = {
    description = "Unlock GPG keys with the disk passphrase";
    wantedBy = [ "multi-user.target" ];
    wants = [ "user@${toString config.users.users.din.uid}.service" ];
    after = [ "user@${toString config.users.users.din.uid}.service" ];
    before = [ "nostrd-unlock.service" ];
    path = [ pkgs.keyutils din-gpg ];
    serviceConfig = {
      Type = "oneshot";
      # See nostrd-unlock: reading the cached key takes root's user keyring.
      KeyringMode = "shared";
    };
    script = ''
      if id=$(keyctl search @u user cryptsetup 2>/dev/null); then
        keyctl pipe "$id" | din-gpg unlock || true
      fi
    '';
  };

  # zsh is the login shell, so it's what the Terminal app opens, dressed in
  # oh-my-zsh's jtriley theme. The empty ~/.zshrc keeps zsh's first-run
  # configuration wizard from appearing.
  programs.zsh = {
    enable = true;
    autosuggestions.enable = true;
    syntaxHighlighting.enable = true;
    ohMyZsh = {
      enable = true;
      theme = "jtriley";
      plugins = [ "git" ];
    };
  };
  systemd.tmpfiles.rules = [ "f /home/din/.zshrc 0644 din users -" ];

  # Desktop, Documents, Downloads, Music, Pictures, Videos, ... in the home
  # directory, and ~/.config/user-dirs.dirs naming them for other apps.
  # xdg-user-dirs' unit waits for a graphical session target that cage never
  # reaches, so it runs at login instead.
  systemd.packages = [ pkgs.xdg-user-dirs ];
  systemd.user.services.xdg-user-dirs.wantedBy = [ "default.target" ];

  # brightnessctl ships udev rules that grant the `video` group write access to
  # /sys/class/backlight, so the Settings brightness panel works unprivileged.
  services.udev.packages = [ pkgs.brightnessctl ];

  # Power profiles for Settings → Power (net.hadess.PowerProfiles over D-Bus,
  # electron/main.mts): power-saver / balanced / performance set the CPU's
  # energy preference and the firmware's platform profile (power limits and
  # fans). Its GPU actions (panel power savings, DPM) are off by default, so
  # the GPU and panel are left alone. UPower tells it when the computer is on
  # battery, so balanced leans toward saving power then.
  services.power-profiles-daemon.enable = true;
  services.upower.enable = true;

  # Let a docked USB keyboard/mouse wake the machine from suspend. Laptops arm
  # only the lid switch as a wake source by default, so when docked (lid shut)
  # and asleep, bumping an external mouse does nothing - you have to crack the
  # lid to wake it. Marking USB devices and their host controllers wake-capable
  # arms them as ACPI wake sources: the `usb` rule covers the input devices and
  # hubs (devices only: their interfaces have no power/wakeup), and the `pci` rule (class 0x0c03xx = USB controllers: xHCI/EHCI/etc.)
  # enables the controller's GPE so a wake actually propagates. Harmless where
  # unsupported - the attribute just won't exist. `add|change` so it applies on
  # both cold-plug and hot-plug (e.g. plugging into the dock while running).
  #
  # The next rule names the ESP the boot loader ran from /dev/disk/dinos-esp
  # (for /boot, below). systemd's by-designator/esp is the first ESP on the
  # disk, which next to Windows is Windows'.
  #
  # The last remaps keys the way hwdb does, from the file din-keyboard
  # writes when the layout needs it (os/din-keyboard.sh).
  services.udev.extraRules = ''
    ACTION=="add|change", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{power/wakeup}="enabled"
    ACTION=="add|change", SUBSYSTEM=="pci", ATTR{class}=="0x0c03*", ATTR{power/wakeup}="enabled"
    SUBSYSTEM=="block", ENV{DEVTYPE}=="partition", ENV{ID_PART_ENTRY_TYPE}=="c12a7328-f81f-11d2-ba4b-00a0c93ec93b", PROGRAM="${isBootedEsp} $env{ID_PART_ENTRY_UUID}", SYMLINK+="disk/dinos-esp"
    ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TEST=="/var/lib/din/keyboard-remap", IMPORT{file}="/var/lib/din/keyboard-remap", IMPORT{builtin}="keyboard"
  '';

  # cage: a Wayland compositor that runs exactly one fullscreen application.
  # This is the entire graphical stack - no X11, no display manager, no desktop.
  # With several monitors, cage's default "extend" mode stretches Din's one
  # window across all of them; Din lays itself out per monitor from there.
  services.cage = {
    enable = true;
    user = "din";
    program = "${din-launcher}/bin/din";
    # cage swallows Ctrl+Alt+Fn unless told otherwise. Without it there is no
    # way to reach a text login on another VT when Din hangs.
    extraArguments = [ "-s" ];
    package = cage-launcher;
  };
  # The keyboard layout, as XKB_DEFAULT_* lines that Settings → Keyboard
  # writes (os/din-keyboard.sh). cage applies it, and Din inherits it.
  systemd.services.cage-tty1.serviceConfig.EnvironmentFile = "-/var/lib/din/keyboard";
  # The GPU's driver loads after the disk unlocks, and cage can start before
  # it has: it finds no GPU and exits, leaving a black screen. It tries
  # again until the driver is there.
  systemd.services.cage-tty1.serviceConfig.Restart = "on-failure";
  systemd.services.cage-tty1.serviceConfig.RestartSec = 1;
  systemd.services.cage-tty1.unitConfig.StartLimitIntervalSec = 60;
  systemd.services.cage-tty1.unitConfig.StartLimitBurst = 10;

  # cage's unit conflicts with the console login on tty1 (autovt@tty1), which
  # getty.target still wants. A system switch re-starts both targets, and
  # whichever job runs last wins: Din was restarted or stopped on every
  # switch. Other VTs still get a login on demand.
  systemd.targets.getty.wants = lib.mkForce [ ];

  # Native Linux software the ordinary way. DinOS users are developers, and
  # the binaries they download (install scripts, release tarballs, AppImages)
  # expect a conventional filesystem that NixOS doesn't have. nix-ld puts a
  # loader at /lib64/ld-linux-x86-64.so.2 that serves the libraries below
  # (on top of its own base set): roughly what desktop, Electron and game
  # binaries link against. envfs fills /bin and /usr/bin from PATH so
  # `#!/bin/bash` scripts run. AppImages launch directly via binfmt.
  #
  # WebKitGTK is the system webview: Tauri, wry and other GTK webview apps
  # load it from the system instead of bundling a browser engine. It adds
  # about 190 MiB on top of what the system already has.
  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      glib gtk3 gtk4 gdk-pixbuf pango harfbuzz cairo atk at-spi2-atk at-spi2-core
      fontconfig freetype dbus expat icu libuuid libnotify libsecret
      nss nspr cups krb5 libusb1 fuse fuse3
      libdrm libgbm libglvnd libGL vulkan-loader wayland libxkbcommon
      libx11 libxcb libxext libxfixes libxrandr libxrender libxi libxcursor
      libxcomposite libxdamage libxtst libxscrnsaver libxshmfence libxkbfile
      alsa-lib libpulseaudio pipewire SDL2
      webkitgtk_4_1 libsoup_3
    ];
  };
  services.envfs.enable = true;
  programs.appimage = {
    enable = true;
    binfmt = true;
  };

  # The Nix way works too: `nix run nixpkgs#foo`, `nix profile install ...`.
  # `din` isn't one of Nix's trusted users: a trusted user can hand the
  # daemon options that run code as root, which would get around sudo's
  # password.
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # Root is a fixed-size volume on an installed system (os/din-install.sh), so
  # the Nix store mustn't grow without end: old systems leave the boot menu
  # after ten, and what's unused for a month goes.
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };
  boot.loader.systemd-boot.configurationLimit = 10;

  # What install scripts and a developer's first hour assume is present.
  # distrobox is the escape hatch for anything else: a full Ubuntu/Fedora/Arch
  # userland with its own package manager, sharing $HOME, in rootless podman
  # (also answering to `docker`).
  environment.systemPackages = with pkgs; [ git unzip distrobox din-keyring ]
    # The command-line userland a Mac ships with, so nobody who sits down at a
    # terminal finds their usual tools missing.
    ++ [
      vim ed file lsof psmisc strace pciutils usbutils sysstat
      # Below NixOS's own lowPrio (10) packages, so the stock `hostname` and
      # `ping` win, and net-tools' `ifconfig` beats inetutils'.
      (lib.setPrio 11 nettools) (lib.setPrio 12 inetutils)
      dnsutils traceroute whois tcpdump
      rsync zip ncompress sharutils pax
      bc units jq libxml2 libxslt sqlite openssl
      perl python3 tcl expect ruby
      screen tmux mksh tcsh dash
      (runCommand "ksh-csh" { } ''
        mkdir -p $out/bin
        ln -s ${mksh}/bin/mksh $out/bin/ksh
        ln -s ${tcsh}/bin/tcsh $out/bin/csh
      '')
      man-pages man-pages-posix texinfo
    ]
    # Not on a Mac, but what developers install first.
    ++ [ ripgrep fd bat htop tree wget gh ]
    # Screenshots of the whole screen. Cage's socket is renamed to din-shell
    # (see the launcher above), so: WAYLAND_DISPLAY=din-shell grim x.png
    ++ [ grim slurp ]
    # The clipboard from the command line (wl-copy, wl-paste, xclip). Native
    # apps' clipboard is Din's, so these reach the whole desktop.
    ++ [ wl-clipboard xclip ]
    # notify-send, for scripts and long builds: Din is the notification server.
    ++ [ libnotify ]
    # AirPlay from the command line too (`deckmon discover`, `deckmon status`).
    ++ [ din-deckmon ]
    # Pointer themes: Adwaita (GTK's own default) and the others Settings offers.
    ++ [ adwaita-icon-theme din-cursor-themes ]
    # xdg-open, and Din as the handler for the links it opens (see
    # xdg.mime.defaultApplications below).
    ++ [
      xdg-utils
      (writeShellScriptBin "din-open" ''
        [ "$#" -gt 0 ] || exit 0
        exec ${systemd}/bin/busctl --user call pub.soapbox.Din /pub/soapbox/Din \
          org.freedesktop.Application Open 'asa{sv}' "$#" "$@" 0
      '')
      (writeTextDir "share/applications/din-open.desktop" ''
        [Desktop Entry]
        Type=Application
        Name=Din Web Browser
        Exec=din-open %U
        MimeType=x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/nsite;
        NoDisplay=true
      '')
    ];
  virtualisation.podman = {
    enable = true;
    dockerCompat = true;
  };

  # OpenCode, the agent behind Din's Assistant (electron/assistant.mts), is
  # the user's own install in ~/.opencode, which updates itself; the disk
  # image comes with it there (os/flake.nix). On PATH,
  # `opencode` in a Terminal attaches to the same background server Din
  # started.
  environment.extraInit = ''
    export PATH="$HOME/.opencode/bin:$PATH"
  '';

  # Flatpak for desktop apps from Flathub, per user and without root. It
  # requires the desktop portals, which the GTK backend provides, except for
  # the file chooser: that's Din's own picker (electron/file-chooser-portal.mts),
  # for Flatpaks and for Chromium and Electron apps, which ask the portal too.
  services.flatpak.enable = true;
  xdg.portal = {
    enable = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-gtk
      (pkgs.writeTextDir "share/xdg-desktop-portal/portals/din.portal" ''
        [portal]
        DBusName=org.freedesktop.impl.portal.desktop.din
        Interfaces=org.freedesktop.impl.portal.FileChooser
      '')
    ];
    config.common = {
      default = "gtk";
      "org.freedesktop.impl.portal.FileChooser" = "din";
    };
  };

  # Links native apps open go to Din's Web Browser (electron/open-uri.mts).
  # Electron and Chromium apps (Signal) run xdg-open, and Flatpaks ask the
  # portal's OpenURI; both start the default handler, din-open, which hands
  # the links to Din over the session bus.
  xdg.mime.defaultApplications = {
    "x-scheme-handler/http" = "din-open.desktop";
    "x-scheme-handler/https" = "din-open.desktop";
    "x-scheme-handler/nsite" = "din-open.desktop";
  };

  systemd.services.flathub = {
    description = "Add the Flathub Flatpak remote";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      Restart = "on-failure";
      RestartSec = 30;
    };
    script = ''
      ${pkgs.flatpak}/bin/flatpak remote-add --if-not-exists flathub \
        https://dl.flathub.org/repo/flathub.flatpakrepo
    '';
  };

  # The pointer's theme and size are GSettings' (cursor-theme, cursor-size),
  # which dconf keeps and GTK - and through it Chromium - follows live
  # (electron/cursor.mts). The themes are din-cursor-themes, above.
  # DinOS's default is Capitaine at 40 (which shows its 36px images), set
  # in the system's dconf database, under whatever the user picks.
  programs.dconf.enable = true;
  programs.dconf.profiles.user.databases = [
    {
      settings."org/gnome/desktop/interface" = {
        cursor-theme = "capitaine-cursors";
        cursor-size = lib.gvariant.mkInt32 40;
      };
    }
  ];

  # Emoji and broad Unicode coverage for web content. noto-fonts has no
  # Chinese, Japanese or Korean, which otherwise render as boxes.
  fonts.packages = with pkgs; [
    noto-fonts
    noto-fonts-cjk-sans
    noto-fonts-cjk-serif
    noto-fonts-color-emoji
  ];

  # fontconfig always ships DejaVu Sans, and left as the default sans-serif
  # it wins over the emoji font for the emoticons it has outlines for (😂
  # and friends), which then render as monochrome text. Noto Sans has no
  # emoji, so Chromium falls back to Noto Color Emoji for all of them.
  fonts.fontconfig.defaultFonts = {
    sansSerif = [ "Noto Sans" "Noto Color Emoji" ];
    serif = [ "Noto Serif" "Noto Color Emoji" ];
    monospace = [ "Noto Sans Mono" "Noto Color Emoji" ];
    emoji = [ "Noto Color Emoji" ];
  };

  # The disk image (`nix build ./os#image`) is written directly to a drive and
  # boots via UEFI. systemd-boot installs to the ESP's removable path
  # (EFI/BOOT/BOOTX64.EFI), so no NVRAM entries are needed on the target
  # machine.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = false;

  # A quiet boot: no boot menu (holding Space while it starts brings it
  # back, for older systems), no kernel or systemd chatter, and no cursor.
  # Plymouth covers the rest with the boot screen.
  boot.loader.timeout = 0;
  boot.consoleLogLevel = 3;
  boot.initrd.verbose = false;
  boot.kernelParams = [
    "quiet"
    "udev.log_level=3"
    "rd.udev.log_level=3"
    "systemd.show_status=auto"
    "rd.systemd.show_status=auto"
    "vt.global_cursor_default=0"
  ];

  # The boot screen, which is also where the disk's password is typed. It
  # looks like Din: the user's wallpaper, a clock, a password field. Those,
  # and the keyboard layout to type with, are on the boot partition
  # (os/din-boot-screen.sh), since nothing on the encrypted disk can be read
  # yet. The screen fades to black once root is mounted and stays that way
  # (--retain-splash) until Din fades in over it.
  boot.plymouth = {
    enable = true;
    theme = "din";
    themePackages = [ boot-screen-theme ];
    font = "${pkgs.inter}/share/fonts/truetype/InterVariable.ttf";
  };
  # Plymouth turns the layout into a keymap with libxkbcommon, which looks
  # for XKB's data where it was built to, a store path the initrd only has
  # if it's asked for. It only uses the layout for keyboards it reads through
  # evdev, which nothing loads in the initrd unless asked: without it, the
  # password is typed through the console's US keymap.
  boot.initrd.systemd.storePaths = [ pkgs.xkeyboard_config ];
  boot.initrd.kernelModules = [ "evdev" ];
  systemd.services.plymouth-quit.serviceConfig.ExecStart = [
    ""
    "${config.boot.plymouth.package}/bin/plymouth quit --retain-splash"
  ];

  # Before Plymouth starts: its images into its ImageDir, then from the boot
  # partition, when it turns up within a few seconds, the wallpaper, the
  # keyboard layout (as vconsole.conf, which Plymouth reads its XKB layout
  # from), the time zone, and the clock's format. Anyone who can write the
  # boot partition can replace the initrd too, so this trusts it no less;
  # it still only takes values that look right.
  boot.initrd.systemd.services.dinos-boot-screen = {
    description = "Prepare DinOS's boot screen";
    unitConfig.DefaultDependencies = false;
    wantedBy = [ "sysinit.target" ];
    after = [ "systemd-udevd.service" "systemd-udev-trigger.service" ];
    before = [ "plymouth-start.service" "sysinit.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      dir=/run/din-boot
      mkdir -p $dir
      cp /etc/plymouth/themes/din/*.png $dir/

      var=/sys/firmware/efi/efivars/LoaderDevicePartUUID-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f
      [ -r $var ] || exit 0
      uuid=$(tail -c +5 $var | tr -d '\0' | tr A-F a-f)
      esp=/dev/disk/by-partuuid/$uuid
      udevadm wait --timeout=5 "$esp" || exit 0
      mkdir -p $dir/esp
      mount -t vfat -o ro,nosuid,nodev,noexec "$esp" $dir/esp || exit 0
      src=$dir/esp/din

      if [ -f $src/wallpaper.png ] && [ "$(stat -c %s $src/wallpaper.png)" -le 16777216 ]; then
        cp $src/wallpaper.png $dir/
      fi

      if [ -f $src/keyboard ]; then
        conf=""
        while IFS='=' read -r key value; do
          [[ $value =~ ^[A-Za-z0-9_.,:+-]+$ ]] || continue
          case $key in
            XKB_DEFAULT_LAYOUT) conf+="XKBLAYOUT=$value"$'\n' ;;
            XKB_DEFAULT_MODEL) conf+="XKBMODEL=$value"$'\n' ;;
            XKB_DEFAULT_VARIANT) conf+="XKBVARIANT=$value"$'\n' ;;
            XKB_DEFAULT_OPTIONS) conf+="XKBOPTIONS=$value"$'\n' ;;
          esac
        done <$src/keyboard
        if [[ $conf == *XKBLAYOUT=* ]]; then
          rm -f /etc/vconsole.conf
          printf '%s' "$conf" >/etc/vconsole.conf
        fi
      fi

      if [ -f $src/localtime ] && [ "$(head -c 4 $src/localtime)" = TZif ]; then
        rm -f /etc/localtime
        cp $src/localtime /etc/localtime
      fi
      if [ "$(head -c 2 $src/clock 2>/dev/null)" = 12 ]; then
        echo 12 >$dir/clock
      fi

      umount $dir/esp
      rmdir $dir/esp
    '';
  };

  # The boot screen's clock: Plymouth scripts can't tell the time, so it's
  # sent to them as a message every minute until the initrd is done.
  boot.initrd.systemd.services.dinos-boot-clock = {
    description = "Show the time on DinOS's boot screen";
    unitConfig.DefaultDependencies = false;
    wantedBy = [ "sysinit.target" ];
    after = [ "plymouth-start.service" "dinos-boot-screen.service" ];
    conflicts = [ "initrd-switch-root.target" ];
    before = [ "initrd-switch-root.target" ];
    script = ''
      format='%H:%M'
      [ "$(cat /run/din-boot/clock 2>/dev/null)" = 12 ] && format='%I:%M %p'
      last=""
      while :; do
        text="din-clock:$(date +"$format")|$(date +'%A, %B %-d')"
        [ -n "$last" ] && plymouth hide-message --text="$last"
        plymouth display-message --text="$text"
        last=$text
        sleep $((60 - 10#$(date +%S)))
      done
    '';
  };

  # Locking. Closing the lid (or Lock in Din's menu) puts up the lock screen
  # (os/din-lock.py) before the computer sleeps. Where the disk is
  # encrypted, it sleeps for two hours, or until the battery runs low, and
  # then hibernates: memory goes to swap on the encrypted disk and the power
  # goes off, so from then on the disk is locked, and the next unlock is at
  # the boot screen. Coming back from that, the lock screen steps aside,
  # since the password was just typed there. Without encryption there's no
  # password: the computer just sleeps.
  systemd.services.din-lock = {
    description = "Lock the screen";
    wantedBy = [ "sleep.target" ];
    before = [ "sleep.target" ];
    serviceConfig = {
      Type = "notify";
      NotifyAccess = "main";
      ExecStart = "${din-lock}/bin/din-lock run";
      # Plymouth takes the keyboard layout from vconsole.conf.
      BindReadOnlyPaths = [ "-/var/lib/din/vconsole.conf:/etc/vconsole.conf" ];
      # Long enough for a slow GPU to come up: on a timeout the computer
      # would sleep unlocked.
      TimeoutStartSec = 60;
    };
  };
  environment.etc."systemd/system-sleep/din-lock".source = pkgs.writeShellScript "din-lock-sleep" ''
    if [ "$1" = post ] && [ "$SYSTEMD_SLEEP_ACTION" = hibernate ]; then
      ${din-lock}/bin/din-lock resumed
    fi
  '';
  systemd.sleep.settings.Sleep.HibernateDelaySec = "2h";

  # Ctrl+Alt+Delete is Din's: in Din it opens the security options screen
  # (src/components/desktop/SecurityOptions.tsx), as on Windows. On the lock
  # screen's terminal, though, the kernel sees the keys itself and has
  # systemd reboot, so anyone at a locked computer, or someone used to
  # pressing it to sign in, would restart it and lose what was open. The
  # target is masked, and pressing it seven times fast does nothing either.
  systemd.ctrlAltDelUnit = "/dev/null";
  systemd.settings.Manager.CtrlAltDelBurstAction = "none";

  # A crashing Electron writes out gigabytes of core, so one crashing in a loop
  # saturated the disk and stalled every app that writes to it. Bigger crashes
  # still get a journal entry, just no core file.
  systemd.coredump.settings.Coredump = {
    ProcessSizeMax = "2G";
    ExternalSizeMax = "2G";
  };

  # Hibernating takes swap as big as memory. On an encrypted root with room
  # to spare, this makes a swap file there and tells logind to hibernate
  # after sleeping; otherwise lids just suspend, as logind does by default.
  # The resume itself needs nothing more: systemd records where the image
  # went in an EFI variable, which the initrd reads after the disk unlocks.
  systemd.services.dinos-hibernation = {
    description = "Set up hibernation on an encrypted disk";
    wantedBy = [ "multi-user.target" ];
    after = [ "local-fs.target" ];
    path = with pkgs; [ coreutils util-linux gawk gnugrep config.systemd.package ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      swap=/var/lib/swap/hibernate
      dropin=/run/systemd/logind.conf.d/50-dinos-hibernate.conf
      mib=$((1024 * 1024))

      root=$(findmnt -nvo SOURCE /)
      if ! lsblk -nso TYPE "$root" | grep -qx crypt; then
        rm -f "$swap" "$dropin"
        exit 0
      fi

      # As big as memory, in whole GiB, if root keeps 16 GiB free besides.
      size=$(awk '/^MemTotal:/ { print int(($2 * 1024 + 2^30 - 1) / 2^30) * 2^30 }' /proc/meminfo)
      have=$(stat -c %s "$swap" 2>/dev/null || echo 0)
      if [ "$have" != "$size" ]; then
        swapoff "$swap" 2>/dev/null || true
        rm -f "$swap"
        free=$(df -B1 --output=avail / | tail -n1)
        if [ $((free - size)) -lt $((16 * 1024 * mib)) ]; then
          echo "Not enough room on root to hibernate."
          rm -f "$dropin"
          exit 0
        fi
        mkdir -p -m 0700 "$(dirname "$swap")"
        fallocate -l "$size" "$swap"
        chmod 0600 "$swap"
        mkswap -q "$swap"
      fi
      # Lowest priority: it's there for hibernating, not to swap to.
      swapon --priority=-2 "$swap" 2>/dev/null || swapon --show=NAME --noheadings | grep -qx "$swap"

      mkdir -p "$(dirname "$dropin")"
      printf '[Login]\nHandleLidSwitch=suspend-then-hibernate\nHandleLidSwitchExternalPower=suspend-then-hibernate\n' >"$dropin"
      systemctl reload systemd-logind || systemctl kill -s HUP systemd-logind
    '';
  };

  # Keeps the boot partition's copy of the layout and time zone current, for
  # systems whose layout was set before the boot screen had one.
  systemd.services.din-boot-screen-sync = {
    description = "Give DinOS's boot screen the keyboard layout and time zone";
    wantedBy = [ "multi-user.target" ];
    after = [ "boot.mount" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${din-boot-screen}/bin/din-boot-screen sync";
    };
  };

  # Likewise Caps Lock's remapping and the text consoles' keymap, for layouts
  # set before there were those.
  systemd.services.din-keyboard-remap = {
    description = "Remap keys for DinOS's keyboard layout";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-udev-trigger.service" "systemd-vconsole-setup.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = [
        "${din-keyboard}/bin/din-keyboard remap"
        "${din-keyboard}/bin/din-keyboard console"
      ];
    };
  };
  # The text consoles take the layout din-keyboard writes, not a fixed one.
  environment.etc."vconsole.conf".source = lib.mkForce "/var/lib/din/console.conf";

  # Settings → Date & Time turns setting the clock from the network off by
  # leaving this file (os/din-time.sh): timedated would disable the unit,
  # which NixOS's read-only /etc doesn't allow.
  systemd.services.systemd-timesyncd.unitConfig.ConditionPathExists = "!/var/lib/din/manual-time";

  # The same image is a live USB stick and, copied by the Installer app, the
  # system on a computer's own disk - often with the stick still plugged in.
  # So nothing is mounted by label, which both copies share: root is the
  # partition of the root type (set on the image in flake.nix) on the disk the
  # boot loader ran from, found by systemd's GPT auto-discovery in a systemd
  # initrd, and /boot is the ESP the boot loader ran from (see the udev rules
  # above).
  #
  # The Installer can encrypt root with LUKS, so the same initrd boots either.
  # These mirror systemd's 90-image-dissect.rules, which NixOS's initrd leaves
  # out: an encrypted root partition shows up as gpt-auto-root-luks and pulls
  # in its own unlock (a passphrase prompt on the console), and the unlocked
  # device becomes gpt-auto-root. A plain root never asks or waits.
  #
  # An installed system's root partition (see os/din-install.sh) holds, under
  # any encryption, LVM: a `dinos` volume group with `root` and `home`
  # volumes, so the system can be reinstalled without touching anyone's
  # files. The group is made with autoactivation off, so neither LVM's own
  # rules nor anything else brings it up; the rules below activate it only
  # when it's in the boot disk's root partition. A DinOS disk that's merely
  # plugged in - the computer's own, under a live stick - is left alone, and
  # two such disks never trip over their shared group name.
  boot.initrd.systemd.enable = true;
  boot.initrd.services.udev.rules = ''
    SUBSYSTEM=="block", ENV{ID_PART_GPT_AUTO_ROOT}=="1", ENV{ID_FS_TYPE}!="crypto_LUKS|LVM2_member", SYMLINK+="gpt-auto-root"
    SUBSYSTEM=="block", ENV{ID_PART_GPT_AUTO_ROOT}=="1", ENV{ID_FS_TYPE}=="crypto_LUKS", SYMLINK+="gpt-auto-root-luks", ENV{SYSTEMD_WANTS}+="systemd-cryptsetup@root.service"
    SUBSYSTEM=="block", ENV{DM_UUID}=="CRYPT-*", ENV{DM_NAME}=="root", ENV{ID_FS_TYPE}!="LVM2_member", SYMLINK+="gpt-auto-root"
    SUBSYSTEM=="block", ENV{ID_PART_GPT_AUTO_ROOT}=="1", ENV{ID_FS_TYPE}=="LVM2_member", ENV{SYSTEMD_WANTS}+="dinos-lvm@$kernel.service"
    SUBSYSTEM=="block", ENV{DM_UUID}=="CRYPT-*", ENV{DM_NAME}=="root", ENV{ID_FS_TYPE}=="LVM2_member", ENV{SYSTEMD_WANTS}+="dinos-lvm@$kernel.service"
    SUBSYSTEM=="block", ENV{DM_NAME}=="dinos-root", SYMLINK+="gpt-auto-root"
  '';
  boot.initrd.luks.devices.root = {
    device = "/dev/gpt-auto-root-luks";
    crypttabExtraOpts = [ "noauto" ];
  };
  # `--devices` keeps LVM from looking at any other disk's `dinos` group.
  # Ordered before the root device counts as found, so by the time root is
  # mounted the home volume is there too.
  boot.initrd.systemd.services."dinos-lvm@" = {
    description = "Activate DinOS's volumes on %i";
    unitConfig.DefaultDependencies = false;
    before = [ "initrd-root-device.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "/bin/lvm vgchange --activate y --devices /dev/%i dinos";
    };
  };
  # /home is mounted here rather than through fileSystems: the live stick and
  # systems installed before the split have no home volume, and must boot as
  # they always have, while an installed system that has one must never come
  # up on an empty /home - if it can't be mounted, booting stops.
  boot.initrd.systemd.services.dinos-home = {
    description = "Mount DinOS's home volume";
    unitConfig = {
      DefaultDependencies = false;
      ConditionPathExists = "/dev/mapper/dinos-home";
    };
    after = [ "initrd-root-device.target" "sysroot.mount" ];
    requires = [ "sysroot.mount" ];
    before = [ "initrd-fs.target" ];
    requiredBy = [ "initrd-fs.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    # e2fsck exits 1 for errors it fixed; 4 and up is trouble.
    script = ''
      e2fsck -p /dev/mapper/dinos-home || [ $? -lt 4 ]
      mount -t ext4 /dev/mapper/dinos-home /sysroot/home
    '';
  };
  # Waiting for root also waits out the passphrase prompt, so it has no time
  # limit: systemd's default 90 seconds dropped a computer left at the prompt
  # into emergency mode.
  fileSystems."/" = {
    device = "/dev/gpt-auto-root";
    fsType = "ext4";
    options = [ "x-systemd.device-timeout=0" ];
  };
  fileSystems."/boot" = {
    device = "/dev/disk/dinos-esp";
    fsType = "vfat";
    options = [ "umask=0077" "nofail" ];
  };

  # Booted from a USB stick (as the Installer and updater tell, by the root
  # disk being removable or on USB), DinOS keeps what it can off the stick.
  # A cheap one manages about 4 small flushed writes a second, some taking
  # five seconds, and Din froze along with them. So the log stays in memory,
  # reading a file doesn't write its access time, and the filesystem commits
  # once a minute; Din skips Chromium's flushes (the launcher, above) and its
  # caches go in memory too (dinos-live-caches). /run/din/live marks such a
  # boot. What a session keeps - the sign-in, saved WiFi, nostrd's keys -
  # still goes on the stick, for the next boot and for the Installer to copy.
  systemd.services.dinos-live = {
    description = "Spare the USB stick DinOS is running from";
    wantedBy = [ "sysinit.target" ];
    before = [ "sysinit.target" ];
    after = [ "local-fs.target" "systemd-journal-flush.service" ];
    unitConfig.DefaultDependencies = false;
    path = [ pkgs.util-linux pkgs.coreutils config.systemd.package ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      root=$(findmnt -nvo SOURCE /)
      part=/sys/class/block/''${root#/dev/}
      [ -e "$part/partition" ] || exit 0
      disk=$(readlink -f "$part/..")
      if [ "$(cat "$disk/removable")" != 1 ] && [[ $disk != */usb* ]]; then
        exit 0
      fi
      mkdir -p /run/din /run/systemd/journald.conf.d
      touch /run/din/live
      mount -o remount,noatime,lazytime,commit=60 /
      printf '[Journal]\nStorage=volatile\n' > /run/systemd/journald.conf.d/dinos-live.conf
      journalctl --relinquish-var
    '';
  };
  # Chromium's caches under Din's profile (Electron's default name, as Din's
  # host has no package.json of its own) and ~/.cache, as tmpfs.
  systemd.services.dinos-live-caches = {
    description = "Keep Din's caches in memory on a USB stick";
    wantedBy = [ "multi-user.target" ];
    before = [ "systemd-user-sessions.service" "cage-tty1.service" ];
    after = [ "dinos-live.service" "local-fs.target" ];
    unitConfig.ConditionPathExists = "/run/din/live";
    path = [ pkgs.util-linux pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      home=/home/din
      profile=$home/.config/Electron
      [ -d "$home" ] || exit 0
      for dir in "$home/.cache" "$profile/Cache" "$profile/Code Cache" "$profile/GPUCache" \
        "$profile/DawnGraphiteCache" "$profile/DawnWebGPUCache"; do
        mountpoint -q "$dir" && continue
        runuser -u din -- mkdir -p "$dir"
        mount -t tmpfs -o mode=0700,uid=${toString config.users.users.din.uid},gid=${toString config.ids.gids.users},size=25%,nosuid,nodev tmpfs "$dir"
      done
    '';
  };

  # Storage controllers commonly found in real machines, so the initrd can
  # mount the root filesystem wherever the image lands (NVMe, SATA, USB, SD).
  boot.initrd.availableKernelModules = [
    "xhci_pci" "ehci_pci" "ahci" "nvme" "usb_storage" "usbhid" "sd_mod"
    "sdhci_pci"
    # The ESP, which the boot screen reads before root is unlocked.
    "vfat" "nls_cp437" "nls_iso8859_1"
  ];

  # GPU acceleration for cage/Electron, plus the firmware real WiFi and
  # graphics hardware needs.
  hardware.graphics.enable = true;
  hardware.enableRedistributableFirmware = true;

  # BlueZ, for Bluetooth devices (Settings and the menu bar pair and connect
  # them through electron/bluetooth.mts, whose agent answers pairing) and for
  # logging in with a phone: the login screen advertises a GATT service the
  # phone sends the account key to (electron/bluetooth-login.mts). BlueZ's
  # D-Bus policy lets any user do both, so `din` needs no group.
  #
  # One ATT channel, no Enhanced ATT: when a phone connects, BlueZ otherwise
  # opens extra EATT channels to it, and those need an encrypted link, so it
  # asks the phone to pair. The login doesn't pair (the handshake carries its
  # own protection), and the phone's pairing popup stalls it until the
  # link times out.
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
    settings.GATT.Channels = 1;
  };

  # PipeWire + WirePlumber back Din's sound panel (wpctl/pw-play via the
  # Electron audio bridge): output/input device selection, per-app volume, and
  # the test tone. rtkit lets the audio threads run at real-time priority.
  # Socket-activated per user session, so the `din` cage session gets its own
  # instance with no extra configuration.
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
  };

  # Screen sharing over AirPlay (electron/airplay.mts). deckmon's daemon owns
  # the sessions; it runs in the user manager rather than under Din, so that
  # `deckmon` in the Terminal reaches the same one (one it started itself
  # would capture the Terminal's nested display, not the screen). It finds
  # cage by the socket name Din's launcher gives it. Receivers are found over
  # mDNS, and send timing and sound control back to airplayPorts.
  systemd.user.services.deckmon = {
    description = "AirPlay sender";
    wantedBy = [ "default.target" ];
    unitConfig.ConditionUser = "din";
    environment.WAYLAND_DISPLAY = "din-shell";
    # sudo, for the virtual display's EDID.
    path = [ "/run/wrappers" ];
    serviceConfig = {
      ExecStart = "${din-deckmon}/bin/deckmon daemon";
      Restart = "on-failure";
    };
  };
  # Ending a session tells the receiver to stop (RTSP TEARDOWN); without it the
  # receiver freezes on the last frame. On shutdown the user manager and the
  # network would otherwise stop together, and Wi-Fi was gone before deckmon
  # got to say goodbye. Ordering it after network.target stops it first.
  systemd.services."user@".after = [ "network.target" ];
  networking.firewall.allowedUDPPorts = [ 5353 ];
  networking.firewall.allowedUDPPortRanges = [ airplayPorts ];

  # Man and info pages, like any Unix. Skip /share/doc and the NixOS manual to
  # keep the image lean-ish.
  documentation.doc.enable = false;
  documentation.nixos.enable = false;
  environment.defaultPackages = [ ];

  # QEMU demo settings — these apply only to the `./os#vm` variant, never to
  # the disk image.
  virtualisation.vmVariant = {
    # The demo VM has no GPU (no virgl), so fall back to software rendering.
    # --enable-unsafe-swiftshader: with the GPU disabled, Chromium >=137
    # refuses to create even software WebGL contexts without this flag, and
    # the Terminal app needs WebGL for crisp box-drawing glyphs ("unsafe" =
    # SwiftShader is not security-maintained against untrusted WebGL content;
    # acceptable for a demo).
    services.cage.program = lib.mkForce
      "${makeDinLauncher "--disable-gpu --enable-unsafe-swiftshader"}/bin/din";

    # Serial console so `npm run os:run` shows boot logs in the terminal too.
    # Plymouth would draw on the serial console instead of the window.
    boot.kernelParams = [ "console=ttyS0" "plymouth.ignore-serial-consoles" ];

    virtualisation = {
      memorySize = 4096;
      cores = 4;
      graphics = true;
      # Emulated HDA card so the sound panel has a real sink/source to detect
      # and select. `audiodev none` = a silent host backend (the demo host may
      # have no audio); the guest device still enumerates and is controllable.
      qemu.options = [
        "-audiodev" "none,id=snd0"
        "-device" "intel-hda"
        "-device" "hda-duplex,audiodev=snd0"
      ];
    };
  };

  system.stateVersion = "26.05";
}
