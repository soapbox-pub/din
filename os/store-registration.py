# The Nix database's registration, in the format of pkgs.closureInfo's (for
# nix-store --load-db: path, NAR hash, NAR size, deriver, reference count,
# references), for the closure of the store paths given. Each path's
# references are found by scanning its NAR - its files, as Nix serialises
# them - for the hashes of other paths, as Nix does when it registers a
# build, and the NAR's hash and size are taken in the same pass.
#
# For make-stick-image.nix, in place of pkgs.closureInfo: the system names
# its optional features' derivations (os/configuration.nix), and Nix counts
# every output of every derivation in a closure as part of it there,
# outputs this machine never built. Only the store the build sees is
# scanned for, so what's found is the closure Nix itself registered.
import hashlib
import os
import re
import stat
import struct
import sys

STORE = "/nix/store"
HASH = re.compile(rb"[0-9a-df-np-sv-z]{32}")

by_hash = {}
for name in os.listdir(STORE):
    if len(name) > 33 and name[32] == "-":
        by_hash[name[:32].encode()] = name


class Nar:
    def __init__(self):
        self.sha = hashlib.sha256()
        self.size = 0
        self.refs = set()
        self.tail = b""

    def raw(self, data):
        self.sha.update(data)
        self.size += len(data)

    def scan(self, data):
        buf = self.tail + data
        for m in HASH.finditer(buf):
            name = by_hash.get(m.group())
            if name:
                self.refs.add(name)
        self.tail = buf[-31:]

    def str(self, data):
        self.raw(struct.pack("<Q", len(data)))
        self.raw(data)
        if len(data) % 8:
            self.raw(b"\0" * (8 - len(data) % 8))

    def contents(self, path, length):
        self.raw(struct.pack("<Q", length))
        self.tail = b""
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                self.raw(chunk)
                self.scan(chunk)
        if length % 8:
            self.raw(b"\0" * (8 - length % 8))

    def node(self, path):
        st = os.lstat(path)
        self.str(b"(")
        self.str(b"type")
        if stat.S_ISLNK(st.st_mode):
            target = os.fsencode(os.readlink(path))
            self.str(b"symlink")
            self.str(b"target")
            self.str(target)
            self.tail = b""
            self.scan(target)
        elif stat.S_ISDIR(st.st_mode):
            self.str(b"directory")
            for entry in sorted(os.listdir(os.fsencode(path))):
                self.str(b"entry")
                self.str(b"(")
                self.str(b"name")
                self.str(entry)
                self.str(b"node")
                self.node(os.path.join(os.fsencode(path), entry))
                self.str(b")")
        else:
            self.str(b"regular")
            if st.st_mode & 0o100:
                self.str(b"executable")
                self.str(b"")
            self.str(b"contents")
            self.contents(path, st.st_size)
        self.str(b")")


info = {}
todo = [os.path.basename(p) for p in sys.argv[1:]]
while todo:
    name = todo.pop()
    if name in info:
        continue
    nar = Nar()
    nar.str(b"nix-archive-1")
    nar.node(os.fsencode(os.path.join(STORE, name)))
    info[name] = nar
    todo.extend(nar.refs - info.keys())

lines = []
for name in sorted(info):
    nar = info[name]
    lines += [f"{STORE}/{name}", f"sha256:{nar.sha.hexdigest()}", str(nar.size), "", str(len(nar.refs))]
    lines += [f"{STORE}/{ref}" for ref in sorted(nar.refs)]
sys.stdout.write("\n".join(lines) + "\n")
drvs = sum(name.endswith(".drv") for name in info)
print(f"{len(info)} paths, {drvs} derivations, {sum(n.size for n in info.values())} bytes", file=sys.stderr)
