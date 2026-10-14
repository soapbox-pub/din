{ config, pkgs, lib, din, ... }:

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
      ];
  };

  # Build the Vite/React desktop environment from source (deps fetched via
  # lockfile hash).
  din-app = pkgs.buildNpmPackage {
    pname = "din";
    version = "0.1.0";
    src = din-src;
    npmDepsHash = "sha256-W2/xr9qmsII6t/m6uNzg2sntGyuc9ylFROzz+As0GDw=";

    # The electron npm package (used by `npm run dev` on dev machines) tries
    # to download its binary in a postinstall hook; the VM uses nixpkgs
    # Electron instead, and there's no network in the build sandbox anyway.
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

    # The package.json scripts run `npm i` (network); run vite directly instead.
    buildPhase = ''
      runHook preBuild
      npm exec -- vite build -l error
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/din
      cp -r dist $out/share/din/dist
      # The whole Electron host: main.mts and the .mts modules it imports
      # (run via Node's native type stripping - no build step), the .cjs
      # preloads, and the pty helper.
      install -m444 electron/main.mts $out/share/din/main.mts
      install -m444 electron/devtools-bridge.mts $out/share/din/devtools-bridge.mts
      install -m444 electron/userscripts.mts $out/share/din/userscripts.mts
      install -m444 electron/preload.cjs $out/share/din/preload.cjs
      install -m444 electron/webview-preload.cjs $out/share/din/webview-preload.cjs
      install -m555 electron/pty-host.py $out/share/din/pty-host.py

      # Runtime node modules for main.mts's Chrome extension support
      # (electron-chrome-extensions + electron-chrome-web-store and their
      # transitive runtime deps). Resolved relative to main.mts, so they
      # live in a node_modules directory beside it.
      mkdir -p $out/share/din/node_modules
      for dep in electron-chrome-extensions electron-chrome-web-store electron-chrome-context-menu debug ms adm-zip; do
        cp -r node_modules/$dep $out/share/din/node_modules/
      done
      runHook postInstall
    '';
  };

  # Launcher: Electron running the Din host on Wayland (cage provides the
  # compositor), GPU-accelerated. `extraFlags` exists so the QEMU demo
  # variant below can swap in software rendering.
  # python3 must be on PATH for the Terminal app's pty host (pty-host.py),
  # nmcli for the Settings app's WiFi bridge, brightnessctl + gammastep for the
  # Settings/menu-bar brightness bridge (backlight + night light), wpctl
  # (wireplumber) for the Settings sound bridge's device/stream control and
  # pw-play (pipewire) for its test tone, Xvfb for the embedded display
  # native Linux apps run on (electron/native-display.mts), and setxkbmap plus
  # xkeyboard-config's rules for their keyboard layout (electron/keyboard.mts).
  makeDinLauncher = extraFlags: pkgs.writeShellScriptBin "din" ''
    export PATH=${pkgs.python3}/bin:${pkgs.networkmanager}/bin:${pkgs.brightnessctl}/bin:${pkgs.gammastep}/bin:${pkgs.wireplumber}/bin:${pkgs.pipewire}/bin:${pkgs.xorg.xvfb}/bin:${pkgs.xorg.setxkbmap}/bin:$PATH
    export XKB_CONFIG_ROOT=${pkgs.xkeyboard_config}/share/X11/xkb
    exec ${pkgs.electron}/bin/electron \
      ${din-app}/share/din/main.mts \
      --ozone-platform=wayland ${extraFlags}
  '';
  din-launcher = makeDinLauncher "";
in
{
  networking.hostName = "aladdin";

  # NetworkManager backs Din's WiFi settings panel (nmcli via the
  # Electron wifi bridge). Physical adapters (wired and wireless) are
  # picked up by NetworkManager automatically.
  networking.networkmanager.enable = true;

  # Unprivileged user Din runs as. `networkmanager` group membership lets the
  # WiFi settings panel control connections without polkit prompts; `video`
  # lets the brightness bridge write the backlight (via brightnessctl's udev
  # rules below) without root; `audio` grants access to the sound devices the
  # PipeWire sound bridge drives. `input` lets the Electron host read keyboard
  # event nodes directly for the laptop box-select screenshot key
  # (KEY_SELECTIVE_SCREENSHOT), whose keysym Chromium can't identify - see
  # electron/main.mts. The main process already observes every keystroke via
  # before-input-event; nothing new is exposed to renderers.
  users.users.web = {
    isNormalUser = true;
    description = "Din desktop user";
    extraGroups = [ "networkmanager" "video" "audio" "input" ];
  };

  # brightnessctl ships udev rules that grant the `video` group write access to
  # /sys/class/backlight, so the Settings brightness panel works unprivileged.
  services.udev.packages = [ pkgs.brightnessctl ];

  # Let a docked USB keyboard/mouse wake the machine from suspend. Laptops arm
  # only the lid switch as a wake source by default, so when docked (lid shut)
  # and asleep, bumping an external mouse does nothing - you have to crack the
  # lid to wake it. Marking USB devices and their host controllers wake-capable
  # arms them as ACPI wake sources: the `usb` rule covers the input devices and
  # hubs, and the `pci` rule (class 0x0c03xx = USB controllers: xHCI/EHCI/etc.)
  # enables the controller's GPE so a wake actually propagates. Harmless where
  # unsupported - the attribute just won't exist. `add|change` so it applies on
  # both cold-plug and hot-plug (e.g. plugging into the dock while running).
  services.udev.extraRules = ''
    ACTION=="add|change", SUBSYSTEM=="usb", ATTR{power/wakeup}="enabled"
    ACTION=="add|change", SUBSYSTEM=="pci", ATTR{class}=="0x0c03*", ATTR{power/wakeup}="enabled"
  '';

  # cage: a Wayland compositor that runs exactly one fullscreen application.
  # This is the entire graphical stack - no X11, no display manager, no desktop.
  services.cage = {
    enable = true;
    user = "web";
    program = "${din-launcher}/bin/din";
  };

  # Emoji and broad Unicode coverage for web content.
  fonts.packages = with pkgs; [
    noto-fonts
    noto-fonts-color-emoji
  ];

  # The disk image (`nix build ./os#image`) is written directly to a drive and
  # boots via UEFI. systemd-boot installs to the ESP's removable path
  # (EFI/BOOT/BOOTX64.EFI), so no NVRAM entries are needed on the target
  # machine.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = false;

  # The image is built at a minimal size; on first boot the root partition and
  # filesystem grow to fill whatever disk it was written to.
  boot.growPartition = true;
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
    autoResize = true;
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-label/ESP";
    fsType = "vfat";
  };

  # Storage controllers commonly found in real machines, so the initrd can
  # mount the root filesystem wherever the image lands (NVMe, SATA, USB, SD).
  boot.initrd.availableKernelModules = [
    "xhci_pci" "ehci_pci" "ahci" "nvme" "usb_storage" "usbhid" "sd_mod"
    "sdhci_pci"
  ];

  # GPU acceleration for cage/Electron, plus the firmware real WiFi and
  # graphics hardware needs.
  hardware.graphics.enable = true;
  hardware.enableRedistributableFirmware = true;

  # PipeWire + WirePlumber back Din's sound panel (wpctl/pw-play via the
  # Electron audio bridge): output/input device selection, per-app volume, and
  # the test tone. rtkit lets the audio threads run at real-time priority.
  # Socket-activated per user session, so the `web` cage session gets its own
  # instance with no extra configuration.
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
  };

  # Keep the image lean-ish.
  documentation.enable = false;
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
    boot.kernelParams = [ "console=ttyS0" ];

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
