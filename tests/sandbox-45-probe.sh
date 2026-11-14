#!/bin/bash
# sandbox-45-probe.sh — tick zf6: what Omarchy 4.5's per-monitor workspaces do
# to the moves Dock Recall makes, measured in the nested compositor.
#
# Since tick zf6 the nested compositor runs the real
# default/hypr/monitor-workspaces.lua (see tests/nested.lua). Every monitor owns
# a block of ten ids — block 0 = 1..10, block 1 = 11..20 — and a reconcile on
# each monitor add/remove and config reload moves and RENUMBERS workspaces to
# keep it so. The engine has to move windows into that world, and five things
# about it were unknown. This script asks each of them and prints the answer;
# tests/nested-notes.md records what they were on the day (2026-11-14).
#
#   (a) a window on the block-0 monitor moved with hl.dsp.window.move to ws 13,
#       which does not exist yet: which monitor does 13 land on?
#   (b) window.move({monitor = NAME}) then a move to ws 13: does it land on the
#       block-1 monitor, without moving focus? And is there a single-dispatch
#       form that does the same?
#   (c) is a window parked on ws 901 renumbered by a reconcile (config reload)?
#   (d) how long after an output create/remove do the block file, the merged
#       file and the workspace set stop changing?
#   (e) is a headless output's identity its connector name?
#
# It is a PROBE, not a gate: the answers are findings, and only a question the
# run could not answer at all fails it. The isolation footer is the gate part —
# the desk's own monitor-workspaces files must keep their mtimes.
#
# Through sandbox_up only, like every nested run (tests/nested.lua refuses any
# other start). One at a time — the library's flock says so.
#
# Usage: tests/sandbox-45-probe.sh

set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB_DIR/sandbox-lib.sh"

# Not a restore scenario: no seeded identity, so the sandboxed plugin service
# has nothing to restore and stays out of the way. The class only has to be
# one nothing else uses.
APP_ID="dr-probe"
B1="sbx-b1"     # becomes block 1 (the nested WAYLAND-1 output takes block 0)
B2="sbx-b2"     # becomes block 2; the one (d) plugs and unplugs

sandbox_up

MW_BLOCK="$SBOX/home/.local/state/omarchy/monitor-workspaces"
MW_MERGED="$SBOX/home/.local/state/omarchy/monitor-workspaces-merged"

declare -A ANSWER

# ------------------------------------------------------------------ helpers

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

ws_of()   { nested clients -j | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.workspace.id)//empty'; }
mon_of()  { nested clients -j | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.monitor)//empty'; }
mon_name() { nested monitors all -j | jq -r --argjson i "$1" 'first(.[]|select(.id==$i)|.name)//empty'; }
ws_monitor() { nested workspaces -j | jq -r --argjson w "$1" 'first(.[]|select(.id==$w)|.monitor)//empty'; }
ws_exists() { [[ -n $(ws_monitor "$1") ]]; }
active_addr() { nested activewindow -j 2>/dev/null | jq -r '.address // "none"'; }
focused_mon() { nested monitors -j | jq -r 'first(.[]|select(.focused)|.name)//empty'; }
block_of_conn() { awk -F'\t' -v c="$1" '$2==c{print $1}' "$MW_BLOCK"; }
identity_of_conn() { awk -F'\t' -v c="$1" '$2==c{print $3}' "$MW_BLOCK"; }
ws_set() { nested workspaces -j | jq -c '[.[]|select(.id>0)|{id,monitor}]|sort_by(.id)'; }

dispatch() {   # dispatch <lua expression> — to the NESTED instance only
  local out
  out=$(nested dispatch "$1" 2>&1)
  note "dispatch $1 -> ${out:-<empty>}"
}

# spawn <tag> <workspace> — a foot window of class dr-probe-<tag> on <workspace>,
# silently; echoes its address.
spawn() {
  local cls="$APP_ID-$1" addr=""
  nested dispatch "hl.dsp.exec_cmd([[ [workspace $2 silent] foot --app-id=$cls sleep 3600 ]])" >/dev/null
  for _ in $(seq 40); do
    addr=$(nested clients -j | jq -r --arg c "$cls" 'first(.[]|select(.class==$c)|.address)//empty')
    [[ -n $addr ]] && break
    sleep 0.25
  done
  echo "$addr"
}

# The state (d) watches, as one string: block file, merged file, workspace set.
state_sig() { echo "$(md5sum < "$MW_BLOCK" 2>/dev/null)|$(md5sum < "$MW_MERGED" 2>/dev/null)|$(ws_set)"; }

# measure <hyprctl args...> — run one nested hyprctl command, then poll
# state_sig every ~50 ms until it has not changed for QUIET ms (max 20 s).
# Sets M_RET (ms until the command returned) and M_LAST (ms until the last
# change seen, against the signature taken just BEFORE the command; 0 = no
# change at all), or M_LAST=timeout.
QUIET=3000
measure() {
  local t0 t prev sig last_change=-1 deadline
  prev=$(state_sig)
  t0=$(now_ms)
  nested "$@" >/dev/null
  M_RET=$(( $(now_ms) - t0 ))
  deadline=$(( t0 + 20000 ))
  while :; do
    t=$(now_ms)
    sig=$(state_sig)
    if [[ $sig != "$prev" ]]; then last_change=$t; prev=$sig; fi
    if (( t - (last_change < 0 ? t0 : last_change) >= QUIET )); then
      M_LAST=$(( last_change < 0 ? 0 : last_change - t0 )); return
    fi
    (( t > deadline )) && { M_LAST=timeout; return; }
    sleep 0.05
  done
}

# Let the module's removal timer and any reconcile behind it run out, without
# guessing a duration: the state has to have stopped moving.
quiesce() { measure version; }

dump() {
  note "monitors   $(nested monitors all -j | jq -c '[.[]|{id,name,description,ws:.activeWorkspace.id,focused}]')"
  note "workspaces $(ws_set)"
  note "blocks     $(tr '\t\n' '|;' < "$MW_BLOCK" 2>/dev/null)"
  note "merged     $(tr '\t\n' '|;' < "$MW_MERGED" 2>/dev/null)"
}

# ------------------------------------------------------------------- stage

echo "=== stage: block 0 = the nested WAYLAND output, block 1 = $B1 ==="

errs=$(nested configerrors 2>&1 | tr -d '[:space:]')
[[ -z $errs ]] && pass "nested config loaded clean (configerrors blank)" \
  || fail "nested configerrors: $(nested configerrors 2>&1 | head -5)"

BASE=$(nested monitors all -j | jq -r 'first(.[]|.name)')
nested output create headless "$B1" >/dev/null
poll 15 monitor_present "$B1" || { fail "$B1 never appeared"; sandbox_verdict "sandbox-45-probe"; }
poll 15 bash -c "[[ -n \$(awk -F'\t' -v c='$B1' '\$2==c' '$MW_BLOCK') ]]" || fail "$B1 never got a row in the block table"
quiesce
dump

BLOCK_BASE=$(block_of_conn "$BASE"); BLOCK_B1=$(block_of_conn "$B1")
if [[ $BLOCK_BASE == 0 && $BLOCK_B1 == 1 ]]; then
  pass "stage: $BASE owns block 0 (1..10), $B1 owns block 1 (11..20)"
else
  fail "stage: blocks are $BASE=$BLOCK_BASE $B1=$BLOCK_B1, not 0/1 — the questions below assume them"
fi

# An anchor that holds the nested focus, so "did focus move" has an answer.
ANCHOR=$(spawn anchor 1)
[[ -n $ANCHOR ]] || { fail "the anchor window never appeared"; sandbox_verdict "sandbox-45-probe"; }
dispatch "hl.dsp.focus({ window = \"address:$ANCHOR\" })"
poll 5 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl activewindow -j | jq -r .address) == $ANCHOR ]]" \
  || note "warning: the anchor did not take the nested focus"
note "anchor $ANCHOR on ws $(ws_of "$ANCHOR"), focus $(active_addr) on $(focused_mon)"

# back_to_1 <addr> — return a window to ws 1 and wait for 13 to be gone.
back_to_1() {
  nested dispatch "hl.dsp.window.move({ workspace = \"1\", follow = false, window = \"address:$1\" })" >/dev/null
  poll 5 bash -c "! HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl workspaces -j | jq -e 'any(.[]; .id==13)' >/dev/null" \
    || note "warning: ws 13 still exists after its window left"
}

# --------------------------------------------------------------------- (a)

# move_to_13 <addr> — window.move by address to ws 13, follow = false; waits.
move_to_13() {
  dispatch "hl.dsp.window.move({ workspace = \"13\", follow = false, window = \"address:$1\" })"
  poll 5 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg a '$1' 'first(.[]|select(.address==\$a)|.workspace.id)') == 13 ]]"
}

# focus_state — "<active window>@<focused monitor>", for before/after compares.
focus_state() { echo "$(active_addr)@$(focused_mon)"; }

echo "=== (a) block-0 window, window.move to not-yet-existing ws 13 ==="
W=$(spawn a 2)
[[ -n $W ]] || fail "(a) window never appeared"
note "window $W on ws $(ws_of "$W") ($(ws_monitor "$(ws_of "$W")"))"
ws_exists 13 && fail "(a) ws 13 already exists — the question is about a new one"

# a1: the nested focus on the SAME monitor as the window (the anchor).
move_to_13 "$W"
A1_MON=$(ws_monitor 13)
quiesce
note "a1 after quiesce: window on ws $(ws_of "$W"), ws 13 on '$(ws_monitor 13)'"

# What the next reconcile makes of a 13 sitting on the block-0 monitor.
measure reload
A1_RELOAD="after a reload the window is on ws $(ws_of "$W") on '$(ws_monitor "$(ws_of "$W")")'"
note "a1 $A1_RELOAD"
back_to_1 "$W"

# a2: the nested focus on the block-1 monitor, window still on block 0 — does
# a new workspace follow the window's monitor or the focused one?
dispatch "hl.dsp.focus({ monitor = \"$B1\" })"
note "a2 focus $(focus_state); window on ws $(ws_of "$W")"
move_to_13 "$W"
A2_MON=$(ws_monitor 13)
back_to_1 "$W"

if [[ $A1_MON == "$BASE" && $A2_MON == "$B1" ]]; then
  A_RULE="on the FOCUSED monitor, not the window's and not block 1's owner"
elif [[ $A1_MON == "$BASE" && $A2_MON == "$BASE" ]]; then
  A_RULE="on the window's monitor, whatever has focus"
else
  A_RULE="by no rule this probe recognises"
fi
ANSWER[a]="ws 13 is created $A_RULE — focus on $BASE: on '${A1_MON:-?}'; focus on $B1: on '${A2_MON:-?}' (block 1 is $B1's). Left on $BASE, $A1_RELOAD"
[[ -n $A1_MON && -n $A2_MON ]] && pass "(a) answered" || fail "(a) ws 13 never appeared"

# --------------------------------------------------------------------- (b)

echo "=== (b) window.move({monitor}) then ws 13 — and a single-dispatch form ==="

# two_step <label> <extra keys for the monitor move>
two_step() {
  local before after ws mon
  dispatch "hl.dsp.focus({ window = \"address:$ANCHOR\" })"
  before=$(focus_state)
  dispatch "hl.dsp.window.move({ monitor = \"$B1\", window = \"address:$W\"$2 })"
  poll 5 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg a '$W' 'first(.[]|select(.address==\$a)|.workspace.id)') -gt 10 ]]"
  note "after monitor move: ws $(ws_of "$W") on $(mon_name "$(mon_of "$W")"), focus $(focus_state)"
  move_to_13 "$W"
  quiesce
  ws=$(ws_of "$W"); mon=$(ws_monitor "${ws:-0}"); after=$(focus_state)
  TWO="$1: ws ${ws:-?} on '${mon:-?}', focus $([[ $after == "$before" ]] && echo unchanged || echo "MOVED $before -> $after")"
  note "$TWO"
  back_to_1 "$W"
}
two_step "move{monitor} then move{ws 13}" ""
B_PLAIN=$TWO
two_step "move{monitor,follow=false} then move{ws 13}" ", follow = false"
B_NOFOLLOW=$TWO

# Single-dispatch candidates, each from a clean slate (ws 13 absent, window on
# ws 1 of block 0, focus on the anchor).
single() {   # single <label> dispatch|eval <lua with ADDR placeholder>
  local how="$2" expr="${3//ADDR/$W}" ws mon before after
  dispatch "hl.dsp.focus({ window = \"address:$ANCHOR\" })"
  before=$(focus_state)
  if [[ $how == eval ]]; then
    note "eval $expr -> $(nested eval "$expr" 2>&1)"
  else
    dispatch "$expr"
  fi
  sleep 0.5
  quiesce
  ws=$(ws_of "$W"); mon=$(ws_monitor "${ws:-0}"); after=$(focus_state)
  SINGLE="$1: ws ${ws:-?} on '${mon:-?}', focus $([[ $after == "$before" ]] && echo unchanged || echo "MOVED $before -> $after")"
  note "$SINGLE"
  back_to_1 "$W"
}
single "move{workspace=13,monitor=$B1}" dispatch "hl.dsp.window.move({ workspace = \"13\", monitor = \"$B1\", follow = false, window = \"address:ADDR\" })"
S1=$SINGLE
single "move{ws 13} then workspace.move{13->$B1}" eval "hl.dispatch(hl.dsp.window.move({ workspace = \"13\", follow = false, window = \"address:ADDR\" })); hl.dispatch(hl.dsp.workspace.move({ workspace = \"13\", monitor = \"$B1\" }))"
S3=$SINGLE
# Last on purpose: the rule stays in force until the reload in (c).
single "workspace_rule(13->$B1)+move" eval "hl.workspace_rule({ workspace = \"13\", monitor = \"$B1\" }); hl.dispatch(hl.dsp.window.move({ workspace = \"13\", follow = false, window = \"address:ADDR\" }))"
S2=$SINGLE
ANSWER[b]="$B_PLAIN | $B_NOFOLLOW | single dispatch: $S1 | window then workspace, one eval: $S3 | rule then move, one eval: $S2"
[[ $B_PLAIN != *"ws ?"* ]] && pass "(b) answered" || fail "(b) the window was lost"

# --------------------------------------------------------------------- (c)

echo "=== (c) a window on ws 901 across a config reload ==="
C=$(spawn c 3)
dispatch "hl.dsp.window.move({ workspace = \"901\", follow = false, window = \"address:$C\" })"
poll 5 bash -c "[[ \$(HYPRLAND_INSTANCE_SIGNATURE=$NESTED_SIG hyprctl clients -j | jq -r --arg a '$C' 'first(.[]|select(.address==\$a)|.workspace.id)') == 901 ]]"
C_BEFORE=$(ws_of "$C"); C_MON_BEFORE=$(ws_monitor 901)
note "before reload: window on ws $C_BEFORE (monitor '$C_MON_BEFORE')"
quiesce
note "after quiesce, no reload: window on ws $(ws_of "$C")"
measure reload
C_SETTLE="returned ${M_RET} ms, last change ${M_LAST} ms"
C_AFTER=$(ws_of "$C")
dump
if [[ $C_AFTER == 901 ]]; then
  ANSWER[c]="NOT renumbered: still on ws 901 after reload (${C_SETTLE})"
else
  ANSWER[c]="RENUMBERED: ws 901 -> ws ${C_AFTER:-?} on '$(ws_monitor "${C_AFTER:-0}")' after reload (${C_SETTLE}); merged: $(tr '\t\n' '|;' < "$MW_MERGED")"
fi
[[ -n $C_AFTER ]] && pass "(c) answered" || fail "(c) the window was lost"
errs=$(nested configerrors 2>&1 | tr -d '[:space:]')
[[ -z $errs ]] || fail "after reload, configerrors: $errs"

# --------------------------------------------------------------------- (d)

echo "=== (d) settle time after output create / remove ==="
measure output create headless "$B2"
D1="returned ${M_RET} ms, last change ${M_LAST} ms"; note "create $B2 (new): $D1"; dump

# A window on B2's own workspace, so the removal has something to merge.
E=$(spawn e 4)
dispatch "hl.dsp.window.move({ monitor = \"$B2\", window = \"address:$E\" })"
sleep 0.5; quiesce
note "window $E on ws $(ws_of "$E") on $(mon_name "$(mon_of "$E")")"

measure output remove "$B2"
D2="returned ${M_RET} ms, last change ${M_LAST} ms"; note "remove $B2 (one window): $D2; window now on ws $(ws_of "$E")"; dump

measure output create headless "$B2"
D3="returned ${M_RET} ms, last change ${M_LAST} ms"; note "re-create $B2 (merged restore): $D3; window now on ws $(ws_of "$E") on $(mon_name "$(mon_of "$E")")"; dump

ANSWER[d]="create: $D1 | remove: $D2 | re-create: $D3 (from just before the hyprctl call; quiet window ${QUIET} ms, ~50 ms polls)"
[[ $D1 != *timeout* && $D2 != *timeout* && $D3 != *timeout* ]] && pass "(d) answered" || fail "(d) state never settled"

# --------------------------------------------------------------------- (e)

echo "=== (e) headless identity vs connector ==="
E_DESC=$(nested monitors all -j | jq -r --arg n "$B1" 'first(.[]|select(.name==$n)|.description)')
E_ID=$(identity_of_conn "$B1")
if [[ $E_ID == "$B1" ]]; then
  ANSWER[e]="yes: $B1 has description '${E_DESC}' and identity '$E_ID'"
else
  ANSWER[e]="NO: $B1 has description '${E_DESC}' and identity '$E_ID'"
fi
[[ -n $E_ID ]] && pass "(e) answered" || fail "(e) $B1 has no row in the block table"
note "WAYLAND output: $BASE identity '$(identity_of_conn "$BASE")'"

# ----------------------------------------------------------------- answers

echo "=== ANSWERS (tick zf6) ==="
for k in a b c d e; do
  echo "($k) ${ANSWER[$k]:-unanswered}"
done

sandbox_verdict "sandbox-45-probe"
