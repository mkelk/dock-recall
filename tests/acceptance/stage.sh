#!/bin/bash
# stage.sh — build the directory that omarchy-iso-test --sync-omarchy pushes
# into the guest.
#
# The harness tars <stage>/test/acceptance and <stage>/test/acceptance.d into
# the guest and runs every *-test.sh it finds there except base-test.sh, which
# is the sourced helper library. So a dock-recall run needs a directory shaped
# like an omarchy checkout containing:
#
#   test/acceptance                              omarchy's runner (verbatim)
#   test/acceptance.d/base-test.sh               omarchy's helpers (verbatim)
#   test/acceptance.d/dock-recall-roundtrip-test.sh
#   test/acceptance.d/dock-recall/               this plugin, for local install
#
# The plugin rides inside acceptance.d because that whole directory is tarred
# into the guest verbatim — which is what lets the test install an unpushed
# branch without a git remote. See PROVISIONING.md for why the alternatives
# (git URL, --sync-all, scp) were rejected.
#
# Usage: tests/acceptance/stage.sh <stage-dir> [omarchy-source]
#
#   omarchy-source is where omarchy's own test/acceptance and
#   test/acceptance.d/base-test.sh are copied from: either a local omarchy
#   checkout, or an scp-style host:path. Defaults to $OMARCHY_ISO_HOST's
#   ~/git/omarchy, the fork that carries the acceptance suite. The installed
#   /usr/share/omarchy does NOT ship test/, so a local Omarchy is not enough.

set -euo pipefail

STAGE="${1:?usage: stage.sh <stage-dir> [omarchy-source]}"
OMARCHY_SRC="${2:-${OMARCHY_ISO_HOST:?set OMARCHY_ISO_HOST to the host holding ~/git/omarchy, or pass a source explicitly}:git/omarchy}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$STAGE/test/acceptance.d"

# omarchy's own runner and helpers, unmodified.
if [[ -d $OMARCHY_SRC ]]; then
  cp "$OMARCHY_SRC/test/acceptance" "$STAGE/test/acceptance"
  cp "$OMARCHY_SRC/test/acceptance.d/base-test.sh" "$STAGE/test/acceptance.d/base-test.sh"
else
  scp -q "$OMARCHY_SRC/test/acceptance" "$STAGE/test/acceptance"
  scp -q "$OMARCHY_SRC/test/acceptance.d/base-test.sh" "$STAGE/test/acceptance.d/base-test.sh"
fi
chmod +x "$STAGE/test/acceptance"

# Only our test file is staged, so only it runs — the omarchy suite's own tests
# are not this repository's gate and would only make the loop longer.
cp "$REPO_ROOT/tests/acceptance/dock-recall-roundtrip-test.sh" \
   "$STAGE/test/acceptance.d/dock-recall-roundtrip-test.sh"

# The plugin itself, as the guest will install it: the repo root IS the plugin
# folder, minus git metadata.
rsync -a --delete --exclude='.git' --exclude='.git/' \
  "$REPO_ROOT/" "$STAGE/test/acceptance.d/dock-recall/"

echo "staged $STAGE"
find "$STAGE/test" -maxdepth 2 -mindepth 1 -printf '  %P\n' | sort
