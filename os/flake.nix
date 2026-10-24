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

    # deckmon, the AirPlay sender behind screen sharing (electron/airplay.mts).
    # Its repository is
    # nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/deckmon;
    # it's built here from source (configuration.nix).
    deckmon = {
      url = "git+https://git.shakespeare.diy/npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/deckmon.git";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, din, nostrd, deckmon }:
    let
      system = "x86_64-linux";
      makeImage = nixos: import "${nixpkgs}/nixos/lib/make-disk-image.nix" {
        inherit (nixos) config pkgs;
        lib = nixpkgs.lib;
        format = "raw";
        partitionTableType = "efi";
        diskSize = "auto";
        # An appliance image doesn't need a nixpkgs channel copy on disk.
        copyChannel = false;
        # Mark the root partition as an x86-64 root, which is how the
        # initrd finds it (see fileSystems in configuration.nix).
        postVM = ''
          ${nixpkgs.legacyPackages.${system}.gptfdisk}/bin/sgdisk \
            --typecode=2:4f68bce3-e8cd-4db1-96e7-fbcaf984b709 $diskImage
        '';
      };
    in
    {
      nixosConfigurations.dinos = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din deckmon; };
        modules = [ nostrd.nixosModules.default ./configuration.nix ];
      };

      # The same system plus remote access (debug.nix), for real hardware.
      nixosConfigurations.dinos-debug = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit din deckmon; };
        modules = [ nostrd.nixosModules.default ./configuration.nix ./debug.nix ];
      };

      packages.${system} = {
        # The real product: a disk image for physical machines.
        # `nix build ./os#image` -> ./result/nixos.img; write it to a drive
        # (e.g. `dd if=result/nixos.img of=/dev/sdX bs=4M status=progress`)
        # and boot via UEFI. The root partition grows to fill the disk on
        # first boot. Written to a USB stick, it's a live system whose
        # Installer app puts DinOS on the computer's own disk.
        image = makeImage self.nixosConfigurations.dinos;

        # `nix build ./os#debug-image`: the image with sshd and mDNS. Add an
        # authorized key to /root/.ssh on the written drive before booting.
        debug-image = makeImage self.nixosConfigurations.dinos-debug;

        # `nix build ./os#vm` -> ./result/bin/run-dinos-vm demos the same
        # system in a QEMU window.
        vm = self.nixosConfigurations.dinos.config.system.build.vm;

        default = self.packages.${system}.image;
      };

      checks.${system} =
        let
          test = file: import file {
            pkgs = nixpkgs.legacyPackages.${system};
            modules = [
              nostrd.nixosModules.default
              ./configuration.nix
              # The test driver wants the kernel's messages on its console.
              { boot.consoleLogLevel = nixpkgs.lib.mkForce 7; }
            ];
            inherit din deckmon;
          };
        in
        {
          accounts = test ./tests/accounts.nix;
          boot-screen = test ./tests/boot-screen.nix;
          firmware = test ./tests/firmware.nix;
          lock = test ./tests/lock.nix;
        };
    };
}
