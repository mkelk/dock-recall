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
| `dock-recall-roundtrip-test.sh` | the test, written in the harness's `*-test.sh` style |
| `stage.sh` | builds the directory the harness pushes into the guest |
| `PROVISIONING.md` | what has to exist on the host, and where |

## Running it

```bash
stage=$(mktemp -d)
OMARCHY_ISO_HOST=<the host holding ~/git/omarchy> tests/acceptance/stage.sh "$stage"

cd ~/git/omarchy-iso
PATH=/usr/bin:$PATH ./bin/omarchy-iso-test release/omarchy-4.0.1.iso \
  --reuse-base --no-preview --sync-omarchy "$stage"
```

Two flags are not optional:

- **`--no-preview`** — without it the harness ends by opening the screenshots in
  `imv` on your desktop. The VM itself is always headless (`-display none`), so
  this is the only thing that would put a window on your screen.
- **`PATH=/usr/bin:$PATH`** — the Android SDK ships a `qemu-img` from 2017 that
  shadows the system one and does not support `-F`, which the harness needs to
  create the run overlay. Without the pin the run dies at
  `qemu-img create -f qcow2 -b base.qcow2 -F qcow2`.

Results land in `~/git/omarchy-iso/test-runs/omarchy-4.0.1/runs/<timestamp>/`:
`serial.log`, the harness's own console captures, and `omarchy-acceptance/` with
this test's screenshots and `dock-recall-service.log` — the `[dock-recall]`
lines the service itself emitted during the run.

### Read the right exit code

**The harness exits 1 even when this test passes.** Before the acceptance suite
it runs its own `shortcut_smoke_phase`, and on the current base image three of
its checks fail for reasons that have nothing to do with this plugin:

```
not ok - launcher shortcut opens
not ok - menu shortcut opens
not ok - universal clipboard test opens Chromium
```

That is what turns the harness's exit code red. The line that answers whether
dock-recall is healthy is the suite's own:

```
ok - acceptance suite passed in 18s (artifacts in /tmp/omarchy-acceptance)
```

A whole run takes about 2.5 minutes with `--reuse-base`; the suite itself is
under 20 seconds of that.

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

The layout is recorded through the engine rather than by hand-writing JSON, and
rather than by driving the panel: hand-written JSON rots at the next
`STATE_VERSION` bump, and the panel has no IPC for Record — its only summon
payload is `{"focus":...}`. Recording through `StateModel` is the same code path
the panel writes with, so the file is always schema-correct.

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
