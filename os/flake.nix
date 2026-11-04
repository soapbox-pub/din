{
  description = "DinOS: the flagship OS of Din - a minimal NixOS that boots straight into the Din desktop environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    # The Din desktop environment (the repository root).
    din = {
      url = "path:..";
      flake = false;
    };

    # The signer daemon that holds the account keys. Its repository is
    # nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/nostrd;
    # Nix fetches it from the grasp server over plain git.
    nostrd = {
      url = "git+https://git.shakespeare.diy/npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/nostrd.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # ngit and git-remote-nostr, for git's nostr:// remotes: Din's own source
    # is one, which system updates fetch (os/din-update.sh). Its repository is
    # nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/relay.ngit.dev/ngit;
    # pinned to a release tag, so bump the ref to update it.
    ngit = {
      url = "git+https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit.git?ref=refs/tags/v3.0.5";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # deckmon, the AirPlay sender behind screen sharing (electron/airplay.mts).
    # Its repository is
    # nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/deckmon;
    # it's built here from source (configuration.nix).
    deckmon = {
      url = "git+https://git.shakespeare.diy/npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/deckmon.git";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, din, nostrd, deckmon, ngit }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # The Electron that runs Din (configuration.nix's `electron`), from the
      # system's own nixpkgs, so it shares the system's libraries. It has to
      # be 43.7.8 or later: Electron 41's find-in-page looped forever when the
      # shell had an iframe, freezing the desktop on Ctrl+F
      # (electron/electron#54199). Keep package.json's electron on the same
      # version.
      electron = { _module.args.electron = pkgs.electron_43; };

      # The commit the system is built from, which system updates compare
      # with the tip they fetch (os/din-update.sh): `self.rev` for a clean
      # checkout, `dirtyRev` (the commit plus "-dirty") for one with changes.
      revision = { system.configurationRevision = self.rev or self.dirtyRev or null; };

      # `nixpkgs` in Nix's registry is the system's nixpkgs, so `nix run
      # nixpkgs#foo` gets the same libraries as the system, but fetched when
      # it's first used rather than carried in the image: the source is
      # 470 MB of small files.
      registry = {
        nixpkgs.flake.setFlakeRegistry = false;
        nixpkgs.flake.setNixPath = false;
        nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];
        nix.registry.nixpkgs.to = {
          type = "github";
          owner = "NixOS";
          repo = "nixpkgs";
          inherit (nixpkgs) rev narHash;
        };
      };

      # OpenCode, the agent behind Din's Assistant (electron/assistant.mts),
      # as its v2 installer would put it in ~/.opencode/bin: the npm
      # package's prebuilt binary, run through nix-ld. It's in the image
      # rather than the system, so a new computer has it from the first boot
      # (and the Installer copies it with /home), it updates itself from
      # there, and system updates don't carry it. Bump now and then.
      opencode = pkgs.runCommand "opencode-home-2.1.4" {
        src = pkgs.fetchurl {
          url = "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.4.tgz";
          hash = "sha256-zgWr4tzhBBORyOyM242gZvZA/UcecqyEbcsInEQeEeE=";
        };
      } ''
        tar -xzf $src package/bin/opencode
        install -Dm755 package/bin/opencode $out/bin/opencode
      '';

      makeImage = nixos: import ./make-stick-image.nix {
        inherit (nixos) config pkgs;
        lib = nixpkgs.lib;
        # A fixed size, which nothing grows later: the system, compressed
        # (about 4.3 GB in November 2026), at least 1 GiB free for a live
        # session, which the build checks (make-stick-image.nix), and room
        # for the system to grow. It fits any "8 GB" USB stick, and the
        # less there is, the sooner a stick is written. The Installer sizes
        # an installed system's own.
        diskSize = 6 * 1024;
        # Writable, so it can update itself.
        contents = [{
          source = opencode;
          target = "/home/din/.opencode";
          mode = "u+w";
          user = "din";
          group = "users";
        }];
      };
    in
    {
      # Din as a desktop on another NixOS system, beside the ones it has
      # (desktop-module.nix): import this and set
      # services.desktopManager.din.enable.
      nixosModules.din = import ./desktop-module.nix { inherit din; };
      nixosModules.default = self.nixosModules.din;

      # A throwaway NixOS with that module, for trying it (desktop-vm.nix).
      nixosConfigurations.din-desktop-vm = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ self.nixosModules.din ./desktop-vm.nix ];
      };

      nixosConfigurations.dinos = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din deckmon; ngit = ngit.packages.${system}.default; };
        modules = [ nostrd.nixosModules.default electron revision registry ./configuration.nix ];
      };

      # The same system plus remote access (debug.nix), for real hardware.
      nixosConfigurations.dinos-debug = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din deckmon; ngit = ngit.packages.${system}.default; };
        modules = [ nostrd.nixosModules.default electron revision registry ./configuration.nix ./debug.nix ];
      };

      packages.${system} = {
        # The real product: a disk image for physical machines.
        # `nix build ./os#image` -> ./result/nixos.img; write it to a drive
        # (e.g. `dd if=result/nixos.img of=/dev/sdX bs=4M status=progress`)
        # and boot via UEFI. Written to a USB stick, it's a live system whose
        # Installer app puts DinOS on the computer's own disk.
        image = makeImage self.nixosConfigurations.dinos;

        # `nix build ./os#debug-image`: the image with sshd and mDNS. Add an
        # authorized key to /root/.ssh on the written drive before booting.
        debug-image = makeImage self.nixosConfigurations.dinos-debug;

        # `nix build ./os#vm` -> ./result/bin/run-dinos-vm demos the same
        # system in a QEMU window.
        vm = self.nixosConfigurations.dinos.config.system.build.vm;

        # `nix run ./os#desktop-vm`: plain NixOS with Din on its login screen.
        desktop-vm = self.nixosConfigurations.din-desktop-vm.config.system.build.vm;

        default = self.packages.${system}.image;
      };

      checks.${system} =
        let
          args = {
            pkgs = nixpkgs.legacyPackages.${system};
            modules = [
              nostrd.nixosModules.default
              electron
              ./configuration.nix
              # The test driver wants the kernel's messages on its console.
              { boot.consoleLogLevel = nixpkgs.lib.mkForce 7; }
            ];
            inherit din deckmon;
            ngit = ngit.packages.${system}.default;
          };
          test = file: import file args;
        in
        {
          accounts = test ./tests/accounts.nix;
          desktop-module = import ./tests/desktop-module.nix {
            inherit nixpkgs;
            pkgs = nixpkgs.legacyPackages.${system};
            module = self.nixosModules.din;
          };
          airplay-display = test ./tests/airplay-display.nix;
          boot-screen = test ./tests/boot-screen.nix;
          # Installs onto a disk from the test machine's image, then erases it.
          erase = import ./tests/erase.nix (args // { inherit makeImage; });
          firmware = test ./tests/firmware.nix;
          # Boots the test machine's own disk image, as a USB stick.
          install = import ./tests/install.nix (args // { inherit makeImage; });
          lock = test ./tests/lock.nix;
        };
    };
}
