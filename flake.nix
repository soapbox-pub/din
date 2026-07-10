{
  description = "webos-demo: minimal Linux that boots into a fullscreen Electron shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
    in
    {
      nixosConfigurations.webos = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ ./os/configuration.nix ];
      };

      packages.${system} = {
        # `nix build .#vm` -> ./result/bin/run-webos-vm launches QEMU
        vm = self.nixosConfigurations.webos.config.system.build.vm;
        default = self.packages.${system}.vm;
      };
    };
}
