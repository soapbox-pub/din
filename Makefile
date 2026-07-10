.PHONY: build run clean

# Build the VM runner script (./result/bin/run-webos-vm)
build:
	nix build .#vm

# Build and boot the VM in a QEMU window
run: build
	./result/bin/run-webos-vm

# Remove build output and the VM's persistent disk
clean:
	rm -f result webos.qcow2
