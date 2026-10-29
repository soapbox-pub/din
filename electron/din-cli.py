#!/usr/bin/env python3
"""din: run a web app in a Din window.

Runs a built web app (a folder with an index.html, like a Vite build's
dist/) or a dev server as a Din app at din://<origin>/, with window.din
like a built-in app's. Talks to the running Din over its socket
(electron/din-launch.mts): $DIN_SOCKET, or $XDG_RUNTIME_DIR/din.sock.

The window's console comes out here, and the command lasts as long as the
window: closing it ends the command, and Ctrl-C closes it.
"""

import argparse
import json
import os
import socket
import sys


def socket_path():
    explicit = os.environ.get("DIN_SOCKET")
    if explicit:
        return explicit
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return os.path.join(runtime, "din.sock")
    sys.exit("din: Din isn't running here ($DIN_SOCKET and $XDG_RUNTIME_DIR are unset)")


def app_folder(arg):
    folder = os.path.abspath(arg)
    if not os.path.isdir(folder):
        sys.exit(f"din: no such folder: {arg}")
    if os.path.isfile(os.path.join(folder, "index.html")):
        return folder
    # A project's folder: its build.
    built = os.path.join(folder, "dist")
    if os.path.isfile(os.path.join(built, "index.html")):
        return built
    sys.exit(f"din: no index.html in {folder} (or its dist/)")


COLORS = {"warning": "33", "error": "31", "debug": "2"}


def show(message, color):
    level = message.get("level")
    text = str(message.get("message", ""))
    source = str(message.get("source") or "")
    if level in ("warning", "error") and source:
        # din://tmp-1a2b/assets/x.js -> /assets/x.js
        if source.startswith("din://"):
            source = "/" + source[len("din://"):].partition("/")[2]
        text += f"  ({source}:{message.get('line', 0)})"
    out = sys.stderr if level in ("warning", "error") else sys.stdout
    code = COLORS.get(level)
    if code and color and out.isatty():
        text = f"\033[{code}m{text}\033[0m"
    print(text, file=out, flush=True)


def main():
    parser = argparse.ArgumentParser(
        prog="din",
        description="Run a web app in a Din window, at din://<origin>/.",
        epilog="The window closes when the command ends (Ctrl-C), unless --detach.",
    )
    parser.add_argument(
        "folder", nargs="?",
        help="the built app: a folder with an index.html (or a project whose dist/ has one)")
    parser.add_argument(
        "files", nargs="*",
        help="files to open in it, as if dropped on it")
    parser.add_argument(
        "--url", metavar="URL",
        help="run the app from a dev server (http://localhost:5173) instead of a folder")
    parser.add_argument(
        "--origin", metavar="NAME",
        help="run at din://NAME/ and keep its storage (default: a new origin, forgotten when it closes)")
    parser.add_argument(
        "-d", "--detach", action="store_true",
        help="return once the window is open, and leave it open")
    parser.add_argument(
        "-q", "--quiet", action="store_true",
        help="don't print the window's console")
    parser.add_argument(
        "--no-color", action="store_true",
        help="don't color warnings and errors")
    args = parser.parse_args()

    request = {"detach": args.detach}
    files = list(args.files)
    if args.url:
        request["url"] = args.url
        # With a server, every argument is a file.
        if args.folder:
            files.insert(0, args.folder)
    elif args.folder:
        request["dir"] = app_folder(args.folder)
    else:
        parser.print_usage(sys.stderr)
        sys.exit("din: name a folder, or a dev server with --url")
    if args.origin:
        request["origin"] = args.origin
    for f in files:
        if not os.path.exists(f):
            sys.exit(f"din: no such file: {f}")
    request["paths"] = [os.path.abspath(f) for f in files]

    path = socket_path()
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(path)
    except OSError as error:
        sys.exit(f"din: can't reach Din at {path}: {error.strerror}")
    conn.sendall((json.dumps(request) + "\n").encode())

    color = not args.no_color and "NO_COLOR" not in os.environ
    reader = conn.makefile("r", encoding="utf-8", errors="replace")
    try:
        for line in reader:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            kind = message.get("type")
            if kind == "error":
                sys.exit(f"din: {message.get('message', 'failed')}")
            elif kind == "opened":
                if not args.quiet:
                    note = "" if message.get("ephemeral", True) else " (keeps its storage)"
                    print(f"din: {message.get('source')} at {message.get('url')}{note}",
                          file=sys.stderr, flush=True)
                if args.detach:
                    return 0
            elif kind == "console" and not args.quiet:
                show(message, color)
            elif kind == "closed":
                return 0
    except KeyboardInterrupt:
        # Hanging up closes the window.
        return 130
    finally:
        conn.close()
    # Din went away.
    return 1


if __name__ == "__main__":
    sys.exit(main())
