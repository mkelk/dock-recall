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
#   test/acceptance.d/base-test.sh are copied from: a local omarchy checkout
#   (default ~/git/omarchy, the fork that carries the acceptance suite), or an
#   scp-style host:path. The installed /usr/share/omarchy does NOT ship test/,
#   so a local Omarchy install is not enough.

set -euo pipefail

STAGE="${1:?usage: stage.sh <stage-dir> [omarchy-source]}"
OMARCHY_SRC="${2:-$HOME/git/omarchy}"
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

# Only our own test files are staged, so only they run — the omarchy suite's own
# tests are not this repository's gate and would only make the loop longer.
#
# The runner globs `*-test.sh` and runs them in SORTED order inside ONE boot, so
# the file names carry the ordering:
#
#   dock-recall-appid-migration-test.sh          the v3 --app-id upgrade
#   dock-recall-captures-test.sh                 pictures on disk, and the switch
#   dock-recall-motion-test.sh                   bound durations, and a morph that ran
#   dock-recall-panel-test.sh                    the panel's IPC, both render paths
#   dock-recall-roundtrip-test.sh                record / undock / scatter / redock
#   dock-recall-undock-locked-prepare-test.sh    the locked scenario's setup
#
# The last one is last on purpose: it prepares the guest and stops, leaving the
# rest of its scenario to undock-locked.sh — a HOST script that reaches the VM's
# keyboard over QMP, which is the only way to type into a session lock. Anything
# running after it in the suite would be running against a desk it deliberately
# left arranged.
#
# One boot for all of them because the expensive part is the boot, not the test;
# each file installs the plugin and restarts the shell for itself, and each
# starts by removing the state file, so nothing an earlier scenario left behind
# can explain a later one.
for test_file in "$REPO_ROOT"/tests/acceptance/dock-recall-*-test.sh; do
  [[ -f $test_file ]] || continue
  cp "$test_file" "$STAGE/test/acceptance.d/$(basename "$test_file")"
done

# The plugin itself, as the guest will install it: the repo root IS the plugin
# folder, minus git metadata.
rsync -a --delete --exclude='.git' --exclude='.git/' \
  "$REPO_ROOT/" "$STAGE/test/acceptance.d/dock-recall/"

echo "staged $STAGE"
find "$STAGE/test" -maxdepth 2 -mindepth 1 -printf '  %P\n' | sort
