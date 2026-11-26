#!/bin/zsh
# ios-sdk-setup <Xcode_27.x.xip | Xcode.app>
#
# Build iOS apps with a newer Xcode's iOS SDK on an Intel Mac, where that
# Xcode won't run (Xcode 27 is Apple silicon only; the App Store wants the
# iOS 27 SDK from April 2027). An SDK is data: headers, .tbd stubs and Swift
# interfaces. So this takes the iOS SDK out of the newer Xcode and builds
# with it using:
#   - the installed Xcode (/Applications/Xcode.app, Universal 26.x): its
#     xcodebuild, clang, ld, actool, ibtool and signing;
#   - swift.org's Universal toolchain of the Swift that built the SDK (its
#     Swift interfaces need that compiler), as pub.din.ios<version>, with
#     Xcode's ld linked in (swift.org ships none);
#   - the SDK, its .tbd stubs without the arm64e.x1 target Xcode 26's linker
#     doesn't know, in a copy of Xcode (an APFS clone: no extra space)
#     at ~/Xcodes/Xcode-ios<version>.app, signed ad hoc before anything runs
#     from it (Gatekeeper, then App Management, refuse a changed copy).
#
# Then build with
#   DEVELOPER_DIR=~/Xcodes/Xcode-ios<version>.app/Contents/Developer \
#     xcodebuild -sdk iphoneos<version> -toolchain pub.din.ios<version> ...
# The result records the new SDK in LC_BUILD_VERSION and DTSDKName/Build,
# which is what App Store Connect checks.
set -eo pipefail
src=${1:?usage: ios-sdk-setup <Xcode.xip | Xcode.app>}
base=/Applications/Xcode.app
mkdir -p ~/Xcodes

if [[ $src == *.xip ]]; then
  tmp=~/Xcodes/.expand; rm -rf $tmp; mkdir -p $tmp
  echo "Expanding $src (several minutes)"
  (cd $tmp && xip -x "$src")
  app=$tmp/Xcode.app
else
  app=$src
fi
sdk=$(cd $app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk && pwd -P)
ver=$(plutil -extract Version raw $sdk/SDKSettings.plist)
build=$(plutil -extract ProductBuildVersion raw $sdk/System/Library/CoreServices/SystemVersion.plist 2>/dev/null || echo "?")
iface=$(find $sdk/System/Library/Frameworks/Foundation.framework -name '*.swiftinterface' | head -1)
swift=$(grep -m1 -oE 'swift-compiler-version: Apple Swift version [0-9.]+' $iface | awk '{print $NF}')
echo "iOS $ver SDK ($build), built by Swift $swift"

# swift.org's toolchain for that Swift.
org=/Library/Developer/Toolchains/swift-$swift-RELEASE.xctoolchain
if [[ ! -d $org ]]; then
  pkg=~/Xcodes/swift-$swift-RELEASE-osx.pkg
  curl -fL --progress-bar -o $pkg \
    https://download.swift.org/swift-$swift-release/xcode/swift-$swift-RELEASE/swift-$swift-RELEASE-osx.pkg
  sudo installer -pkg $pkg -target /
  rm -f $pkg
fi
tc=~/Library/Developer/Toolchains/din-ios$ver.xctoolchain
mkdir -p ~/Library/Developer/Toolchains; rm -rf $tc
cp -cR $org $tc
ln -sfn $base/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld $tc/usr/bin/ld
plutil -replace CFBundleIdentifier -string pub.din.ios$ver $tc/Info.plist
plutil -replace DisplayName -string "Din iOS $ver (Swift $swift)" $tc/Info.plist

# The copy of Xcode with the SDK in it.
X=~/Xcodes/Xcode-ios$ver.app
rm -rf $X
echo "Copying $base to $X"
cp -cR $base $X
dest=$X/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS$ver.sdk
cp -cR $sdk $dest
grep -rlE 'arm64e\.x1-ios' $dest --include='*.tbd' | while read -r f; do
  perl -pi -e 's/, *arm64e\.x1-ios//g; s/arm64e\.x1-ios, *//g; s/arm64e\.x1-ios//g' "$f"
done
echo "Signing $X"
codesign --force --sign - --preserve-metadata=identifier,entitlements,flags,runtime $X
codesign --verify $X

# Xcode wants a simulator runtime for the platform's newest SDK before it
# offers "Any iOS Device"; there's none for the new iOS on Intel, so point
# the SDK at the iOS runtime that's installed.
runtime=$(DEVELOPER_DIR=$X/Contents/Developer xcrun simctl runtime list -j 2>/dev/null |
  /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(max((v["build"] for v in d.values() if v.get("platformIdentifier","").endswith("iphonesimulator")), default=""))')
if [[ -n $runtime ]]; then
  DEVELOPER_DIR=$X/Contents/Developer xcrun simctl runtime match set iphoneos$ver $runtime 2>&1 | grep -v RGFX || true
fi

# Gatekeeper checks the new copy the first time anything runs from it.
echo "Gatekeeper is checking $X (a few minutes, once)"
DEVELOPER_DIR=$X/Contents/Developer xcodebuild -version
DEVELOPER_DIR=$X/Contents/Developer xcodebuild -showsdks | grep -i "iphoneos$ver"
[[ -n $tmp ]] && rm -rf $tmp
echo "Ready: DEVELOPER_DIR=$X/Contents/Developer xcodebuild -sdk iphoneos$ver -toolchain pub.din.ios$ver"
