---
name: vms
description: Make and drive virtual machines in Din (macOS, Windows, Ubuntu, Fedora) with `din vms`, installed hands-free and then used over SSH or through their screen, keyboard and pointer. Use when a task needs another OS (building or testing an iOS or Mac app with Xcode, trying something on Windows or another Linux, a throwaway machine to experiment in), or when the user asks about their virtual machines.
---

# Virtual machines

Din's Virtual Machines app keeps QEMU machines in `~/VMs/<name>/`, and
`din vms` does everything it does. A Mac, a Windows PC or a Linux box is
one command away, installed and signed in by itself, and you can drive it
on your own: over SSH, or through its screen, keys and pointer like a
person at its window.

`din help vms` lists every command and `din help vms <command>` gives its
arguments. Machines are named by their name (`macOS`, `Windows 11`,
`Ubuntu`) or any unambiguous part of it.

## Getting a machine

```sh
din vms list                     # what's there, and what each is doing
din vms install macos            # or windows, ubuntu, fedora; --name to name it
din vms list                     # "downloading 40%", "installing 70%", then "stopped" or "running"
din vms start macOS
din vms stop macOS               # the power button; --force pulls the plug
```

- **Ask before installing one.** It's a big download (macOS and Windows
  are several GB) and takes a lot of disk (macOS 128 GB, Windows 80 GB,
  sparse) and half the computer's memory while it runs. Start and stop
  existing machines freely when the task needs them. Stop the ones you
  started when you're done, unless the user wants them kept running.
- An install takes a while: Linux 10 to 20 minutes, Windows and macOS
  30 to 60. Poll `din vms list` every minute or two; nothing needs
  answering. It ends at the desktop, signed in to an account named for
  this computer's user, with no password and passwordless sudo.
- A Mac is drawn on this computer's GPU (Metal works in it) unless
  `din vms set <machine> --gpu off`. `din vms set` also takes `--memory
  <GiB>` and `--cpus`, from its next start.

## SSH: the way to work in a machine

Machines Din installs macOS, Ubuntu or Fedora on have an SSH key of their
own, which only Din holds (`~/VMs/<name>/ssh/`). Their SSH server is on,
and each start forwards a free port on 127.0.0.1 to it. Windows has no SSH;
drive its screen instead.

```sh
din vms ssh macOS -- sw_vers                      # run a command there
din vms ssh macOS -- 'cd ~/app && xcodebuild -list'
din vms ssh macOS < script.sh                     # a script, on its stdin
din vms ssh macOS --json                          # host, port, user, key, argv
```

- Anything after `--` runs in the machine's shell, quoted as with `ssh`.
- For files, use the details from `--json` with `scp` or `rsync`:
  `scp -P <port> -i <key> -o HostKeyAlias=… -o UserKnownHostsFile=…`
  (take every `-o` in its argv). Or stream: `tar c app | din vms ssh macOS
  -- tar x -C ~`.
- SSH needs the machine running and booted. Right after `din vms start`,
  retry for a minute or so until it answers.
- "Din didn't set it up for SSH" means it was installed some other way.
  Drive its screen, or ask the user to set up SSH.

## The screen, keyboard and pointer

For what SSH can't do (GUI apps, dialogs, installers, a machine without
SSH, one that won't boot), use the screen. This works whatever the machine
runs, from its firmware on.

```sh
din vms shot macOS /tmp/opencode/mac.png   # prints the path and size; then read the PNG
din vms click macOS 640 400                # --button right, --double
din vms move macOS 640 400                 # hover
din vms drag macOS 100 100 400 300
din vms scroll macOS 960 600 5             # down 5 notches; -5 is up
din vms type macOS 'hello world'           # ASCII on a US keyboard; \n is return
din vms key macOS cmd+space return         # combinations, one after another
```

- Points are pixels of the screenshot, whose size `shot` prints (the
  guest picks its resolution: 1920×1080 or so for a Mac on the GPU,
  1280×800 on VGA). Take a new shot after each action that changes the
  screen, and look before you click. Things take a moment to appear.
- Keys: `cmd` (the Windows key on a PC), `ctrl`, `alt` (Option), `shift`,
  `return`, `esc`, `tab`, `space`, `backspace` (a Mac's Delete), `delete`,
  arrows `up` `down` `left` `right`, `home`, `end`, `pageup`, `pagedown`,
  `f1` to `f12`, and any letter, digit or symbol.
- `type` can't type what a US keyboard has no key for. Put such text in
  the clipboard over SSH (`pbcopy` on a Mac) and paste it with `cmd+v`.
- On a Mac, `open -a Xcode` or `osascript` over SSH is quicker than
  clicking through Finder.

## Snapshots and ports

```sh
din vms snapshot macOS before-xcode   # save it as it is (a Mac on the GPU only while it's off)
din vms snapshots macOS
din vms restore macOS before-xcode    # asks the user on screen first
din vms forward Ubuntu 8080           # 127.0.0.1:8080 here → its 8080, from its next start
din vms forward Ubuntu 8022 22
din vms unforward Ubuntu 8080
```

Snapshot a machine before something risky you might want to undo.
`restore`, `delete-snapshot` and `remove` (moves the machine to the Trash)
ask the user on screen first, because they lose data.

## Building for Apple platforms

A Mac VM can run Xcode, so iOS and Mac apps can be built here:

1. Get a Mac running: `din vms list`, then start it, or install one if the
   user agrees.
2. Check for Xcode: `din vms ssh macOS -- xcode-select -p` and
   `xcodebuild -version`. Command Line Tools alone aren't enough for iOS.
3. Installing Xcode needs the user's Apple Account (App Store, or
   developer.apple.com). Ask them to sign in at the Mac's window; never
   ask for their Apple Account password in the conversation.
4. Copy the project in over SSH, then build with `xcodebuild` there, and
   use `xcrun simctl` for the Simulator (`simctl io booted screenshot` for
   its screen). Signing for a device needs the user's team and
   certificates.

The Mac is an Intel Mac: macOS 26 is the last for Intel, and Homebrew no
longer supports it (use MacPorts, in `/opt/local`). Xcode 26.x has a
Universal download (`Xcode_26.x_Universal.xip`); the plain one is Apple
silicon only and fails with "Bad CPU type". Put `PATH` in `~/.zshenv` so
`din vms ssh` commands get it. macOS keeps SSH out of `~/Downloads`,
`~/Documents` and `~/Desktop`, and out of app bundles it didn't make, until
someone allows it at the Mac's window.

### The App Store's newest iOS SDK

Xcode 27 runs only on Apple silicon, but from April 2027 App Store Connect
takes only builds made with the iOS 27 SDK (ITMS-90725). An SDK is only
data, so the Mac can build with it anyway: `ios-sdk-setup.sh`, beside this
file, takes the iOS SDK out of the newer Xcode's `.xip` and builds with it
through the installed Xcode 26 and swift.org's Universal toolchain of the
Swift that built the SDK. Apple's validation and processing take the
result as an iOS 27.2 SDK build (tested with Ditto, uploaded to App Store
Connect from a Mac VM, November 2026).

1. Download the newer Xcode's `.xip` in the Mac's Safari (the user signs
   in to developer.apple.com there). Its URL is on
   [xcodereleases.com](https://xcodereleases.com/data.json).
2. Copy the script in and run it, with the `.xip` (or the Xcode.app it
   expands to). It takes about 15 minutes, mostly Gatekeeper's check of
   the new Xcode copy, and asks for sudo once (no password on Din's Macs):

   ```sh
   din vms ssh macOS -- 'mkdir -p ~/bin && cat > ~/bin/ios-sdk-setup && chmod 755 ~/bin/ios-sdk-setup' \
     < /etc/opencode/skills/vms/ios-sdk-setup.sh
   din vms ssh macOS -- 'ios-sdk-setup ~/Downloads/Xcode_27.2.xip'
   ```

3. Build with the copy of Xcode it makes and its toolchain:

   ```sh
   export DEVELOPER_DIR=~/Xcodes/Xcode-ios27.2.app/Contents/Developer
   xcodebuild -project App.xcodeproj -scheme App -configuration Release \
     -sdk iphoneos27.2 -toolchain pub.din.ios27.2 \
     -destination generic/platform=iOS -archivePath /tmp/App.xcarchive archive
   ```

   Export and upload as usual (`xcodebuild -exportArchive`, `xcrun altool
   --upload-app`). Check that `vtool -show-build` on the app's binary
   says `sdk 27.2`.

- It builds for devices only: there's no iOS 27 Simulator on Intel, so
  test in the iOS 26 Simulator or on a phone.
- An app built with the iOS 27 SDK must use the UIScene life cycle, or it
  won't launch on iOS 27 (TN3187); for a Capacitor app that's Capacitor
  8.5 and `npx cap migrate`.
- Its Info.plist still says `DTXcode` 2660 (Xcode 26.6); App Store Connect
  accepted that.
