.PHONY: build run dev clean

# Build the VM runner script (./result/bin/run-webos-vm)
build:
	nix build .#vm

# Build and boot the VM in a QEMU window
run: build
	./result/bin/run-webos-vm

# Run the web shell locally with Vite HMR (http://localhost:8080)
dev:
	npm --prefix shell run dev

# Type-check, lint, test, and build the shell
test:
	npm --prefix shell run test

# Remove build output and the VM's persistent disk
clean:
	rm -f result webos.qcow2
