# reims-vgpu (github.com/steelbrain/reims-vgpu): a virtual GPU for macOS
# guests, which turns their Metal into Vulkan on the host's GPU, and the
# QEMU fork it's built into (its reims-graphics-pci device). The Virtual
# Machines app runs macOS on it (electron/vms.mts); Windows and Linux stay
# on nixpkgs' QEMU. It's a part of the vms feature (configuration.nix),
# which Din's binary cache serves, since nixpkgs' doesn't have it.
#
# Pinned here, each a deliberate move: reims-vgpu's commit (and the QEMU
# commit and keycodemapdb its tree names), and the dated nightly Rust its
# rust-toolchain.toml names, from rust-overlay. Two patches:
# - cargo-lock.patch: the Cargo.lock reims-vgpu commits leaves out
#   metal2vulkan's git `source` lines, which its builds write back in; the
#   vendored build needs them;
# - qemu-collapse-opt-in.patch: QEMU collapses the guest's RAM into huge
#   pages only where QEMU_HOSTMEM_COLLAPSE=1. Over collapsed RAM a macOS
#   guest panicked within minutes on a Radeon 890M
#   (github.com/steelbrain/reims-vgpu/issues/185, qemu-reims-vgpu#20).
{ pkgs, lib }:

let
  rev = "f1c518d312f75715c73dbc2a4ca1f6ebca1b12f9";
  src = pkgs.fetchFromGitHub {
    owner = "steelbrain";
    repo = "reims-vgpu";
    inherit rev;
    hash = "sha256-qLObhfhbaNgBJH3bDSbnF8DGcAinu3mi/rqzHeLXKhw=";
  };
  qemuSrc = pkgs.fetchFromGitHub {
    owner = "steelbrain";
    repo = "qemu-reims-vgpu";
    rev = "0c0ac356981eb48c514006ffb4b14b6fb6b6b339";
    hash = "sha256-KO4/57mtyDZuzlgH7+RZ7sr7FofZfAishbpQ+mKTkI0=";
  };
  # QEMU's meson fetches this subproject at configure; the sandbox can't.
  keycodemapdb = pkgs.fetchgit {
    url = "https://gitlab.com/qemu-project/keycodemapdb.git";
    rev = "f5772a62ec52591ff6870b7e8ef32482371f22c6";
    hash = "sha256-EQrnBAXQhllbVCHpOsgREzYGncMUPEIoWFGnjo+hrH4=";
  };

  rustOverlay = pkgs.fetchFromGitHub {
    owner = "oxalica";
    repo = "rust-overlay";
    rev = "67021b279bfffe654a0201ede805748a255ae5a7";
    hash = "sha256-rsB/BPQf+Q9p7O7WhqtmG64b3F175ly7swafxWS1etM=";
  };
  rustPkgs = pkgs.extend (import rustOverlay);
  # reims-vgpu's rust-toolchain.toml: its crates need 1.98.1 or later, and
  # its Cargo config the nightly's parallel front end (-Zthreads).
  toolchain = rustPkgs.rust-bin.nightly."2026-11-03".minimal;
  rustPlatform = pkgs.makeRustPlatform { cargo = toolchain; rustc = toolchain; };

  # What the library opens at run time, which QEMU's RUNPATH names (the
  # library is linked into it whole): Vulkan and VA-API, for the guest's
  # video, beside the system's GPU drivers' own libraries (NVIDIA's encoder
  # and decoder among them). Not the window system's, which SDL3 opens for
  # the library's own window: Din shows the display in its console, and
  # starts QEMU with REIMS_VGPU_WINDOW=0 (electron/vms.mts).
  runtimeLibs = with pkgs; [ vulkan-loader libva ];
  runtimePath = lib.makeLibraryPath runtimeLibs + ":/run/opengl-driver/lib";

  # The library (`cargo xtask dist`): the static archive QEMU links, its
  # pkg-config file and header, and the stage helper that goes beside QEMU.
  library = rustPlatform.buildRustPackage {
    pname = "reims-vgpu";
    version = "0-unstable-${builtins.substring 0 9 rev}";
    inherit src;
    cargoPatches = [ ./reims-vgpu/cargo-lock.patch ];
    cargoHash = "sha256-ckxpKA16rA+d9FSzrtggbYpZw4UnHWMCvDHUhwz4RTg=";
    nativeBuildInputs = with pkgs; [ pkg-config cmake perl python3 ];
    buildInputs = with pkgs; [ wayland wayland-scanner libxkbcommon libdecor libx11 libxcb xorgproto libxext libxcursor libxi libxrandr libxrender libxinerama libxfixes libxscrnsaver libxtst libGL libdrm dbus udev libva vulkan-loader ];
    dontUseCmakeConfigure = true;
    # Its Cargo config gives every rustc as many front-end threads as the
    # host has cores (-Zthreads=0); keep to the build's own.
    postPatch = ''
      sed -i "s/-Zthreads=0/-Zthreads=$NIX_BUILD_CORES/" .cargo/config.toml
    '';
    # The commit the recorder names in its stats (xtask's build_commit reads
    # it from git, which the source has none of).
    RVG_BUILD_COMMIT = rev;
    buildPhase = ''
      runHook preBuild
      cargo xtask dist --platform vulkan --out "$out"
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/share/reims-vgpu"
      cp firmware/prebuilt/ReimsGraphics.rom "$out/share/reims-vgpu/"
      cp -r guest/prebuilt "$out/share/reims-vgpu/kexts"
      runHook postInstall
    '';
    doCheck = false;
    # The archive is what QEMU links; its debug info is most of its size.
    dontStrip = false;
  };
  # What QEMU's configure checks its Python for (pythondeps.toml), which it
  # would otherwise download: the sandbox has no network.
  python = pkgs.python3.withPackages (ps: [ ps.distlib ps.setuptools ps.wheel ps.pip ps.qemu-qmp ]);
in
pkgs.stdenv.mkDerivation {
  pname = "qemu-reims-vgpu";
  inherit (library) version;
  src = qemuSrc;
  patches = [ ./reims-vgpu/qemu-collapse-opt-in.patch ];
  postPatch = ''
    cp -r ${keycodemapdb} subprojects/keycodemapdb
    chmod -R u+w subprojects/keycodemapdb
    patchShebangs scripts
  '';
  nativeBuildInputs = with pkgs; [ pkg-config meson ninja python flex bison perl ];
  buildInputs = with pkgs; [ glib pixman libslirp zlib dtc libxkbcommon libpng libjpeg libpulseaudio pipewire alsa-lib libusb1 spice spice-protocol gnutls libcap_ng libseccomp liburing libaio zstd ] ++ [ library ];
  dontUseMesonConfigure = true;
  dontUseNinjaBuild = true;
  dontUseNinjaInstall = true;
  configurePhase = ''
    runHook preConfigure
    mkdir build && cd build
    ../configure --prefix="$out" --python=${python}/bin/python3 --disable-download \
      --target-list=x86_64-softmmu --enable-kvm \
      --enable-reims-vgpu --disable-docs --disable-tests --disable-werror \
      --disable-sdl --disable-gtk --enable-slirp --enable-spice --enable-libusb \
      --enable-gnutls --enable-png --enable-vnc-jpeg --disable-strip
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    # And the keymaps, which VNC loads (en-us at least) as it starts.
    ninja qemu-system-x86_64 $(ninja -t targets all | sed -n 's|^\(pc-bios/keymaps/[a-z-]*\): .*|\1|p')
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share"
    cp qemu-system-x86_64 "$out/bin/"
    # The library starts its stage helper from beside the host's executable.
    cp ${library}/bin/reims-vgpu-compile "$out/bin/"
    cp -r ${library}/share/reims-vgpu "$out/share/"
    # The firmware and keymaps an x86-64 machine looks for under QEMU's
    # prefix (its OVMF is the system's, DIN_OVMF).
    mkdir -p "$out/share/qemu"
    mkdir -p "$out/share/qemu/keymaps"
    find pc-bios/keymaps -maxdepth 1 -type f -regex '.*/[a-z-]*' -exec cp {} "$out/share/qemu/keymaps/" \;
    test -f "$out/share/qemu/keymaps/en-us"
    for f in bios-256k.bin kvmvapic.bin linuxboot_dma.bin multiboot_dma.bin pvh.bin efi-virtio.rom efi-e1000e.rom; do
      cp "../pc-bios/$f" "$out/share/qemu/"
    done
    runHook postInstall
  '';
  # The runtime libraries, after fixup's shrink would drop them: none is a
  # DT_NEEDED, all are dlopen()ed.
  postFixup = ''
    patchelf --add-rpath "${runtimePath}" "$out/bin/qemu-system-x86_64"
  '';
  passthru = { inherit library toolchain; };
  meta = {
    description = "QEMU with reims-vgpu's GPU for macOS guests";
    homepage = "https://github.com/steelbrain/reims-vgpu";
    license = lib.licenses.gpl2Plus;
    platforms = [ "x86_64-linux" ];
    mainProgram = "qemu-system-x86_64";
  };
}
