# VM acceptance tests (Tier C)

The node suite pins the pure modules and `tests/sim-dock.sh` drives the live
desk. Neither can answer the question this directory exists for: *does a user
who installs this plugin on a real Omarchy get their windows back when they
redock?* That needs a real install, a real Quickshell, a real Hyprland, and a
desk nobody minds us restarting.

So these tests run inside a disposable Omarchy VM, driven by the `omarchy-iso`
harness. Machine setup — packages, the ISO, the reusable base image, and the
headless mechanism — is in [PROVISIONING.md](PROVISIONING.md).

## Files

| | |
|---|---|
| `run.sh` | **the entrypoint** — stage, boot, run, and answer in an exit code |
| `dock-recall-roundtrip-test.sh` | record, undock, scatter, redock, restored |
| `dock-recall-appid-migration-test.sh` | the v3 `--app-id` upgrade, end to end |
| `stage.sh` | builds the directory the harness pushes into the guest |
| `PROVISIONING.md` | what has to exist on the host, and where |

The in-guest runner globs `*-test.sh` and runs them **in sorted order inside one
boot**, so the file names carry the ordering. `stage.sh` says which order and
why.

## Running it

```bash
OMARCHY_ISO_HOST=<the host holding ~/git/omarchy> ./tests/acceptance/run.sh
```

That is the whole gate. **Exit 0 means every scenario passed inside the VM**;
exit 1 says which of the required lines was missing and prints every
`not ok -` from the run. It stages, pins `PATH=/usr/bin:$PATH`, and passes
`--reuse-base --no-preview`, so none of those can be forgotten. About 5 minutes,
entirely headless.

Results land in `~/git/omarchy-iso/test-runs/omarchy-4.0.1/runs/<timestamp>/`:
`serial.log`, the harness's own console captures, and `omarchy-acceptance/` with
the tests' screenshots, the state files each scenario seeded and migrated, and
`dock-recall-*-service.log` — the `[dock-recall]` lines the service itself
emitted during the run. `run.sh` also keeps the harness's own output at the
`log:` path it prints.

The underlying invocation, for when something needs to be run by hand:

```bash
stage=$(mktemp -d)
OMARCHY_ISO_HOST=<the host holding ~/git/omarchy> tests/acceptance/stage.sh "$stage"

cd ~/git/omarchy-iso
PATH=/usr/bin:$PATH ./bin/omarchy-iso-test release/omarchy-4.0.1.iso \
  --reuse-base --no-preview --sync-omarchy "$stage"
```

Two of those pieces are not optional:

- **`--no-preview`** — without it the harness ends by opening the screenshots in
  `imv` on your desktop. The VM itself is always headless (`-display none`), so
  this is the only thing that would put a window on your screen.
- **`PATH=/usr/bin:$PATH`** — the Android SDK ships a `qemu-img` from 2017 that
  shadows the system one and does not support `-F`, which the harness needs to
  create the run overlay. Without the pin the run dies at
  `qemu-img create -f qcow2 -b base.qcow2 -F qcow2`.

### Background: why `run.sh` parses lines instead of reading an exit code

**The harness exits 1 even when this test passes.** Before the acceptance suite
it runs its own `shortcut_smoke_phase`, and on the current base image three of
its checks fail for reasons that have nothing to do with this plugin:

```
not ok - launcher shortcut opens
not ok - menu shortcut opens
not ok - universal clipboard test opens Chromium
```

That is what turns the harness's exit code red, and it is why
`omarchy-iso-test`'s own status can never be the gate. What *is* unambiguous is
its output, so `run.sh` requires **all** of these lines and nothing less:

```
ok - acceptance suite passed in 122s (artifacts in /tmp/omarchy-acceptance)
ok - dock-recall round trip: record, undock, scatter, redock, restored
ok - dock-recall v3 --app-id upgrade: migrated, converged, repairable
```

All of them, because any one alone is a lie. The suite's line on its own would
go green if the test files never reached the guest and nothing dock-recall-shaped
ran at all; a test's own line alone would mean the suite aborted somewhere after
it. `run.sh` matches them literally (`grep -F`), so a change to any message is a
loud failure rather than a quiet fuzzy match.

A whole run takes about 5 minutes with `--reuse-base`; the suite itself is about
two of those.

## How the plugin reaches the guest

`--sync-omarchy DIR` tars `DIR/test/acceptance` and `DIR/test/acceptance.d` into
the guest and runs the suite from there. Nothing else crosses. So `stage.sh`
puts the plugin tree **inside `acceptance.d/dock-recall/`**, where it rides
along with the test file, and the test installs it from that local path the way
`scripts/dev-install` does: rsync into `~/.config/omarchy/plugins/`,
`rescanPlugins`, `enablePlugin`, then restart the shell.

The alternatives were rejected deliberately:

- **`omarchy plugin add <git-url>`** — the honest user-facing route, but it needs
  the branch pushed to a remote. A test must be runnable on an unpushed branch.
- **`--sync-all`** — pushes a whole omarchy checkout and repoints `OMARCHY_PATH`
  at it, changing what is under test beyond the plugin.
- **scp into the guest** — no hook: the guest is only reachable through the
  harness's own SSH session, which exists for the length of `acceptance_phase`.

## What the test asserts

A full round trip against a fake dock (`hyprctl output create headless`, the
same trick `sim-dock.sh` uses):

1. install the plugin, enable it, restart the shell so the *service* is really
   live — a hot-reloaded service runs QML but never starts a `Process`;
2. launch `foot --title=dock-recall-acceptance`;
3. dock: create the headless output;
4. move the window to workspace 7 on the dock and **record the layout through
   the engine** — `engine.topologyKey`, `engine.monitorLabel` and
   `StateModel.upsertLayout`, written atomically;
5. undock: remove the output, **then scatter the window to workspace 1**;
6. redock: create the output again, and assert the window came back to
   workspace 7 on the dock.

Step 5's scatter is what gives the test teeth, and it is not optional. Removing
the monitor alone proves nothing: the window cannot be "on the dock" while the
dock does not exist, so step 6 would go green the moment Hyprland put
workspace 7 back on the reappearing output from its own workspace-to-monitor
memory — with the plugin asleep. Moving the window to a workspace the recording
does not name removes that explanation, so only something that has read the
recording can put it back.

`success-dock-recall-<step>.png` is captured at each visually distinct state;
`base-test.sh`'s `fail` captures `failure-<step>.png` before aborting.

The layout is recorded through the engine rather than by hand-writing it, and
rather than by driving the panel: a hand-written layout rots at the next
`STATE_VERSION` bump, and the panel has no IPC for Record — its only summon
payload is `{"focus":...}`. Recording through `StateModel` is the same code path
the panel writes with, so the file is always schema-correct.

The identity the test watches *is* hand-written — a literal JSON seed, because
there is no engine call that means "start watching this". Its `version` field is
read out of `StateModel.STATE_VERSION` rather than typed in, which is the part
that would otherwise rot: a seed declaring an older version is read as a
migration, and v4's migration is not purely additive (it can rewrite `launch`),
so a stale number would quietly change what the test believes it seeded.

## What the v3 `--app-id` upgrade test asserts

`dock-recall-appid-migration-test.sh` is the end-to-end proof of finding A1. A
0.2.0 state file carries launch commands the retired backfill wrote —
`<terminal> --app-id=<identity-id> <command>` — which force a window class the
identity's own patterns can never claim. Restoring one spawns a stray window per
dock event plus a 10-second launch timeout, forever. The fix is in the v3 → v4
migration: `StateModel.migratedLaunch` EMPTIES a launch whose forced class no
pattern of the identity claims, and leaves every other launch alone.

The node suite pins that rule against fixtures. This test asks the question the
fixtures cannot — *does a real v3 file, read by a real service, on a real dock
event, converge?* — with two identities, because the discriminator is the
identity and not the flag:

| | patterns | launch | must become |
|---|---|---|---|
| subject | `^foot$` | `foot --app-id=herdr herdr` | `""` |
| control | `^scratchpad$` | `/usr/bin/foot --app-id=scratchpad` | byte-identical |

The seed's `version` is **hardcoded 3**, which is the one place this directory
does not read `StateModel.STATE_VERSION`: the file *is* a v3 file, and reading
the current version would silently stop testing anything the day v5 lands. What
the test does read out of `StateModel` is that 3 is genuinely in the past, so a
future bump makes the seed staler rather than inert.

It then proves three things in sequence:

1. **the service, on the v3 file** — its own log announces the upgrade; no
   `herdr` window appears at any point across 45 seconds of polling; no launch
   is dispatched for the subject at all and `--app-id=herdr` appears nowhere in
   the log; and the launch-timeout count is 0 and still 0 thirty seconds later.
   The file on disk is asserted **still v3**, because that is a contract too:
   the service upgrades in memory and never rewrites a file nobody asked it to
   change.
2. **the write** — the migration persists at the next legitimate write, and none
   of the three (Record, a panel edit, a pause toggle) has an IPC surface a
   headless test can drive. So the test performs the plugin's own write path
   itself: `StateModel.parseState` → `serializeState` → temp-and-rename, byte
   for byte what `Panel.writeState` does. `parseState` is the code under test,
   not a re-implementation of it. The file that lands is v4, subject emptied,
   control verbatim.
3. **the file the user is left with** — the persisted v4 file is reloaded by the
   live service (no second migration announced), a second dock event runs, and
   nothing strays and nothing times out.

Assertion (d), that an emptied launch is not a dead end, is checked through
`PanelModel`: `identitiesNeedingLaunch` lists the subject and not the control,
and `launchRepairIndex` offers the subject a derived command while leaving the
control's runnable one alone. Empty is precisely the shape the repair machinery
supports; a stripped-but-wrong command would be non-empty and runnable, which is
what neither of them will ever touch.

Both seeded and migrated state files are copied into the artifacts directory, so
the migration is auditable after the VM is gone.

## Guest packages

The test installs `jq`, `foot` and `nodejs` in the guest if they are missing
(`pacman`, as the guest's own `omarchy` user with the harness's known password).
`node` is needed to record through the engine. This is a throwaway VM built from
the base image every run, so nothing accumulates.

## Sanitization

Everything in the guest is synthetic: the harness installs with user `omarchy`,
password `omarchy`, and the test's own window title is
`dock-recall-acceptance`. No host paths, host name or personal data cross into
the VM — `--sync-omarchy` copies only this directory and the plugin tree.
Screenshots are of that VM's desktop, not yours; they are deliberately **not**
committed, and stay under `test-runs/` on the host.
