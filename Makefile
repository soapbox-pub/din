.PHONY: build run dev dev-browser test clean

# Build the VM runner script (./result/bin/run-webos-vm)
build:
	nix build .#vm

# Build and boot the VM in a QEMU window
run: build
	./result/bin/run-webos-vm

# Run the shell in Electron with live HMR (windowed, DevTools open).
# Starts Vite, then launches Electron (from the flake's pinned nixpkgs)
# against it. This mirrors the VM's Electron host; Ctrl-C stops both.
dev:
	./shell/scripts/dev-electron.sh

# Run the shell in a plain browser with Vite HMR (http://localhost:8080).
# (GNU make can't use a ':' in target names, hence 'dev-browser'.)
dev-browser:
	npm --prefix shell run dev:browser

# Type-check, lint, test, and build the shell
test:
	npm --prefix shell run test

# Remove build output and the VM's persistent disk
clean:
	rm -f result webos.qcow2
