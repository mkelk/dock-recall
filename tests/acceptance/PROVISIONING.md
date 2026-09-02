# VM acceptance harness — provisioning on the dev box

Tier C of the sandbox model runs dock-recall acceptance tests inside a real
Omarchy VM. The harness is `omarchy-iso`; it is **not** vendored here and not
committed anywhere in this repository. This note records what has to exist on
the machine, where it lives, and how a run stays invisible.

## Harness

Cloned from the machine that built it, outside any git worktree:

| | |
|---|---|
| Path | `~/git/omarchy-iso` |
| Origin | the build host (`$OMARCHY_ISO_HOST`, see below) |
| Branch / commit | `quattro` @ `268bac16d351a21d867e37565738f458b11cb06c` |
| Size | 2.8 MB (scripts only) |

The `archiso` submodule is deliberately left uninitialized: it is only needed to
*build* an ISO, and we copy a released one instead.

`$OMARCHY_ISO_HOST` throughout this note means the machine that built the ISO
and the base image — the box with `~/git/omarchy-iso` and the omarchy fork on
it, reachable over SSH. It is named in the operator's SSH config, not here.

Entry point is `bin/omarchy-iso-test`. Relevant flags: `--reuse-base`,
`--sync-omarchy DIR`, `--sync-all DIR`, `--no-preview`, `--keep-running`,
`--install-only`, `--port`, `--timeout`.

## Host prerequisites

The harness installs its own dependencies on first run, via line 86 of
`bin/omarchy-iso-test`:

```
omarchy-pkg-add qemu-full edk2-ovmf socat imagemagick tesseract tesseract-data-eng
```

`omarchy-pkg-add` shells out to `sudo pacman -S --noconfirm --needed`, so an
unattended agent run hits an interactive sudo prompt unless the packages are
already present. **Pre-install them:**

```
sudo pacman -S --needed qemu-full edk2-ovmf
```

Only those two were missing on this machine; `socat`, `imagemagick`,
`tesseract` and `tesseract-data-eng` were already installed. `qemu-full` is the
full meta-package and pulls ~118 packages. Installing the leaner `qemu-base`
instead does **not** work: the harness checks for `qemu-full` by name and would
try to install it anyway.

KVM needs no group change on this machine — `/dev/kvm` is `crw-rw-rw-`,
`kvm_amd` is loaded, and the CPU reports `svm`.

### The `qemu-img` PATH trap

The Android SDK is on `PATH` ahead of `/usr/bin` and ships its own `qemu-img`:

```
$ which -a qemu-img
~/Android/Sdk/emulator/qemu-img           # version 2.12.0 (2017)
/usr/bin/qemu-img                             # version 11.1.0
```

The 2017 build has no `-F` flag, and `acceptance_phase` creates its throwaway
overlay with `qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2`. Run the
harness with `/usr/bin` pinned in front:

```
PATH=/usr/bin:$PATH ./bin/omarchy-iso-test ...
```

## Headless — nothing appears on the desktop

This is a hard constraint, and the harness already satisfies it. `start_vm`
(line 204) launches:

```
qemu-system-x86_64 -cpu host -enable-kvm -machine q35,accel=kvm \
  ... -device virtio-vga -display none -usb -device usb-tablet \
  -qmp "unix:$QMP_SOCK,server,nowait" -serial "file:$serial" -daemonize
```

`-display none -daemonize` means no GTK/SDL window and no focus steal. The VM is
driven entirely through QMP (screendump + OCR to read screens, `send-key` to
type) and its serial log.

The one thing that *would* become visible is `open_screenshots()` (line 162),
which runs `imv` on the collected PNGs when `WAYLAND_DISPLAY`/`DISPLAY` is set.
**Always pass `--no-preview`.** That is the only desktop-visible surface in the
whole harness.

## Artifacts copied from the build host

Both were rsync'd (`--partial`) rather than rebuilt.

| Artifact | Path | Size |
|---|---|---|
| ISO | `~/git/omarchy-iso/release/omarchy-4.0.1.iso` | 5.9 GiB (6227752960 B) |
| ISO checksum | `~/git/omarchy-iso/release/omarchy-4.0.1.iso.sha256` | verified with `sha256sum -c` |
| Base disk | `~/git/omarchy-iso/test-runs/omarchy-4.0.1/base.qcow2` | 5.9 GiB (6231293952 B) |
| OVMF vars | `~/git/omarchy-iso/test-runs/omarchy-4.0.1/OVMF_VARS.4m.fd` | 528 KiB |
| Guest SSH key | `~/git/omarchy-iso/test-runs/omarchy-4.0.1/id_ed25519{,.pub}` | harness-generated, guest-only |

ISO sha256: `69cbb4e10d98ad831c3c9f245b5757a9d1fedfd0c9592780e977d6f950dea8c3`

### What `--reuse-base` reuses

`test-runs/<iso-name>/base.qcow2` — a qcow2 of a completed unattended install.
With `--reuse-base` the harness skips the whole install phase (the slow part:
the OCR-driven configurator walk) and goes straight to `acceptance_phase`, which
creates a throwaway overlay `runs/<timestamp>/run.qcow2` backed by `base.qcow2`,
boots it, and SSHes in. The base is never mutated by a run, so runs are
repeatable and disposable.

Because the base is a full install image, copying it from the build host avoids a
~40 minute install on every fresh checkout.

## Headless smoke boot (verification)

Before trusting the suite, the ISO was booted directly with the harness's own
launch line, `-display none`, into `test-runs/smoke-<timestamp>/`. It proved the
whole reading mechanism on this machine:

- UEFI came up and handed off to the ISO —
  `BdsDxe: starting Boot0002 "UEFI QEMU DVD-ROM QM00011"` in `serial.log`;
- a QMP `screendump` produced a frame, `magick` converted it, and `tesseract`
  read `OMARCHY / Beautiful, Modern & Opinionated Linux by DHH` off it — the
  exact screendump + OCR path the harness steers the installer with;
- `hyprctl clients -j` filtered for a `qemu` class returned `[]` **while the VM
  was running**: nothing appeared on the desktop.

`serial.log` and `boot-screen.png` are kept in that directory as the evidence.

## Run layout

Each invocation writes `test-runs/omarchy-4.0.1/runs/<YYYYmmdd-HHMMSS>/`
containing `run.qcow2`, `serial.log`, `qemu.pid`, the harness's own
`success-*.png` / `failure-*.png` console captures, and `omarchy-acceptance/`
— the in-guest artifacts (per-test screenshots) tarred back out of `/tmp`.

## How a dock-recall test reaches the guest

`--sync-omarchy DIR` tars **`DIR/test/acceptance` and `DIR/test/acceptance.d`**
into the guest at `~/.local/share/omarchy/test/`, then runs
`bash .local/share/omarchy/test/acceptance`. The runner executes every
`*-test.sh` in `acceptance.d` except `base-test.sh`, which is the sourced helper
library.

So a dock-recall run uses a staging directory shaped like an omarchy checkout:

```
<stage>/test/acceptance            # the runner, copied from the omarchy fork
<stage>/test/acceptance.d/base-test.sh          # helpers, copied unchanged
<stage>/test/acceptance.d/dock-recall-roundtrip-test.sh
<stage>/test/acceptance.d/dock-recall/          # the plugin worktree itself
```

Staging only our own test file means only it runs, which keeps the loop short.

The plugin source rides along **inside `acceptance.d/`**, because that whole
directory is tarred into the guest verbatim. The test then installs it from that
local path. This was chosen over the alternatives deliberately:

- *`omarchy plugin add <git url>`* would need the branch pushed to a remote, and
  this chain must not push.
- *`--sync-all`* pushes an entire omarchy checkout and repoints `OMARCHY_PATH`
  at it, which changes what is under test beyond the plugin.
- *scp into the guest* has no harness hook — the guest is only reachable through
  the harness's own SSH session during `acceptance_phase`.

## Invocation

`tests/acceptance/run.sh` is the entrypoint and wraps all of this; what it runs
underneath is:

```
cd ~/git/omarchy-iso
PATH=/usr/bin:$PATH ./bin/omarchy-iso-test release/omarchy-4.0.1.iso \
  --reuse-base --no-preview --sync-omarchy <stage>
```

`--no-preview` and the `PATH` pin are both load-bearing; see above. The harness's
exit code is not the gate — `run.sh` parses the run's output instead, and
`tests/acceptance/README.md` explains why.
