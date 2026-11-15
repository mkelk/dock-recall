#!/bin/bash
# sandbox-fidelity-probe.sh — tick ejc: the compositor facts epic 9i2
# (within-workspace fidelity) rests on, measured in the nested compositor.
#
# The 9i2 plan (tab group = one tile, active tab recorded and restored, a tree
# the plugin built itself, layout modes refused by name) assumes seven things
# about Hyprland 0.56 that nobody had measured. This script asks each of them
# and prints the answer with the raw read-back; tests/nested-notes.md, section
# "9i2 fidelity facts", records what they were on the day.
#
#   (a) which clients-JSON field names a group's ACTIVE TAB — on a shown
#       workspace, on a hidden one, and on one that has NEVER been shown
#       (candidates: visible, hidden, lowest focusHistoryID among members),
#       judged against the compositor's own answer (Lua `window.group.current`);
#   (b) hl.dsp.group.active({ index, window }): selector honoured? index base?
#       does it move activewindow or the shown workspace? and what focus({window})
#       on a hidden workspace does to the shown one, and whether refocusing home
#       undoes it;
#   (c) hl.dsp.window.resize on a group member (active and non-active tab)
#       moves the group tile's divider, and the near-side sign law holds;
#   (d) window.swap with a NON-active member swaps the whole tile;
#       layout("togglesplit") with a member focused flips the tile's parent;
#   (e) member-chain arrival: leader on the workspace, members arriving with
#       focus on their predecessor, then the joins in tab order — adjacent
#       (no scratch fallback)? does the leader's tile keep its rect?
#   (f) under force_split=2 / preserve_split, which axis an arrival's split
#       takes, and whether togglesplit with the ARRIVAL focused flips exactly
#       the node it made;
#   (g) layout modes: tiledLayout of a scrolling workspace, whether a rule for
#       a not-yet-existing workspace is readable, what swap/resize/togglesplit
#       answer on scrolling, float on/off absolute and idempotent, and how an
#       omarchy-floating-workspace tag reads in clients `tags`.
#
# It is a PROBE, not a gate: the answers are findings, and only a question the
# run could not answer at all fails it. The isolation footer is the gate part.
#
# Through sandbox_up only, like every nested run (tests/nested.lua refuses any
# other start). One at a time — the library's flock says so. Omarchy's own
# dwindle settings (looknfeel.lua: force_split = 2, preserve_split = true) are
# set with `nested eval` unless tests/nested.lua already sets them.
#
# Usage: tests/sandbox-fidelity-probe.sh

set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB_DIR/sandbox-lib.sh"

# Not a restore scenario: no seeded identity, so the sandboxed plugin service
# has nothing to restore and stays out of the way.
APP_ID="dr-fp"

sandbox_up

declare -A ANSWER

# ------------------------------------------------------------------ helpers

PRIMARY=$(primary_monitor)
ws() { expected_ws "$PRIMARY" "$1"; }

cj() { nested clients -j; }
addr_of() { cj | jq -r --arg c "$APP_ID-$1" 'first(.[]|select(.class==$c)|.address)//empty'; }
cls_of()  { cj | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.class)//empty' | sed "s/^$APP_ID-//"; }
ws_of()   { cj | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.workspace.id)//empty'; }
shown()   { nested monitors -j | jq -r --arg m "$PRIMARY" 'first(.[]|select(.name==$m)|.activeWorkspace.id)//empty'; }
aw()      { nested activewindow -j 2>/dev/null | jq -r '.address // "none"'; }
awc()     { local a; a=$(aw); [[ $a == none ]] && echo none || cls_of "$a"; }

d() { local out; out=$(nested dispatch "$1" 2>&1 | tr '\n' ' ' | sed 's/ *$//'); echo "${out:-<empty>}"; }
focus() { d "hl.dsp.focus({ window = \"address:$1\" })" >/dev/null; sleep 0.2; }
mv_ws() { d "hl.dsp.window.move({ window = \"address:$1\", workspace = \"$2\", follow = false })" >/dev/null; sleep 0.3; }

# spawn <tag> <workspace> — a foot window of class dr-fp-<tag>, silently; echoes its address.
spawn() {
  local cls="$APP_ID-$1" addr=""
  nested dispatch "hl.dsp.exec_cmd([[ [workspace $2 silent] foot --app-id=$cls sleep 3600 ]])" >/dev/null
  for _ in $(seq 60); do
    addr=$(cj | jq -r --arg c "$cls" 'first(.[]|select(.class==$c)|.address)//empty')
    [[ -n $addr ]] && break
    sleep 0.25
  done
  sleep 0.3
  echo "$addr"
}

# geo <addr> — "x y w h" of a window.
geo() { cj | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|"\(.at[0]) \(.at[1]) \(.size[0]) \(.size[1])")//empty'; }
rect() { local g; read -r -a g <<< "$(geo "$1")"; echo "${g[0]:-?},${g[1]:-?} ${g[2]:-?}x${g[3]:-?}"; }

# rects <ws> — one line per window on <ws>, sorted by position.
rects() {
  cj | jq -r --argjson w "$1" --arg p "$APP_ID-" '
    (map({key:.address, value:(.class|sub("^"+$p;""))})|from_entries) as $c
    | [.[]|select(.workspace.id==$w)] | sort_by(.at[0], .at[1], .class)[]
    | "\(.class|sub("^"+$p;"")) at=\(.at|join(",")) size=\(.size|join("x")) float=\(.floating) visible=\(.visible) hidden=\(.hidden) fhid=\(.focusHistoryID) grouped=[\(.grouped|map($c[.] // .)|join(","))] tags=\(.tags|tojson)"' \
    | sed 's/^/      /'
}

in_group_with() { cj | jq -e --arg a "$1" --arg g "$2" 'first(.[]|select(.address==$a)|.grouped|index($g))!=null' >/dev/null; }
group_order() { cj | jq -r --arg a "$1" 'first(.[]|select(.address==$a)|.grouped)|.[]' | while read -r x; do cls_of "$x"; done | paste -sd,; }

# join <candidate> <predecessor> <anchor> — Service.qml's joinGroup, without the
# scratch fallback: focus the predecessor, focus the candidate, into_group, for
# each direction in turn. Sets JOIN_DIR to the direction that took (or "none").
join() {
  local dir
  JOIN_DIR=none
  for dir in left right up down; do
    focus "$2"; focus "$1"
    d "hl.dsp.window.move({ into_group = \"$dir\" })" >/dev/null; sleep 0.25
    if in_group_with "$1" "$3"; then JOIN_DIR=$dir; return 0; fi
  done
  return 1
}

# The compositor's own answer for a group's active tab: Lua's HL.Group.current
# (hl.meta.lua types it), written by `hyprctl eval` into the sandbox and read
# back. "?" when the eval cannot write (no io in eval) or the window is gone.
TRUTH_FILE="$SBOX/group-truth.txt"
truth_raw() {
  rm -f "$TRUTH_FILE"
  nested eval "local f = io.open('$TRUTH_FILE', 'w')
for _, w in ipairs(hl.get_windows()) do
  local a = tostring(w.address)
  if (a == '$1' or ('0x' .. a) == '$1') and w.group then
    local c = w.group.current
    f:write(tostring(c and c.address) .. ' ' .. tostring(w.group.current_index) .. ' ' .. tostring(w.group.size))
  end
end
f:close()" >/dev/null 2>&1
  cat "$TRUTH_FILE" 2>/dev/null || echo "?"
}
truth_tab() {   # truth_tab <member addr> -> class of the current tab, or ?
  local raw a; raw=$(truth_raw "$1"); a=${raw%% *}
  [[ $a == "?" || $a == nil || -z $a ]] && { echo "?"; return; }
  [[ $a == 0x* ]] || a="0x$a"
  cls_of "$a"
}

# candidates <addr...> — what each candidate field says the active tab is.
candidates() {
  cj | jq -r --arg p "$APP_ID-" --args '
    [.[]|select(.address as $a | $ARGS.positional | index($a))] as $m
    | ($m|map(select(.visible==true))|map(.class|sub("^"+$p;""))|join("+")) as $vis
    | ($m|map(select(.hidden==false))|map(.class|sub("^"+$p;""))|join("+")) as $hid
    | ($m|min_by(.focusHistoryID)|.class|sub("^"+$p;"")) as $fh
    | "visible=true:[\($vis)] hidden=false:[\($hid)] min-fhid:\($fh)"' "$@"
}

# tab_read <label> <addr...> — truth vs candidates, one line, also returned in TAB_LINE.
tab_read() {
  local label="$1"; shift
  TAB_TRUTH=$(truth_tab "$1")
  TAB_LINE="$label: truth(Group.current)=$TAB_TRUTH [$(truth_raw "$1")] | $(candidates "$@") | shown ws $(shown), activewindow $(awc)"
  note "$TAB_LINE"
}

# Which candidate fields agree with the truth, from a candidates line.
agree() {   # agree <truth> <candidates line>
  local t="$1" line="$2" out=()
  [[ $line == *"visible=true:[$t]"* ]] && out+=(visible)
  [[ $line == *"hidden=false:[$t]"* ]] && out+=(hidden)
  [[ $line == *"min-fhid:$t "* || $line == *"min-fhid:$t" ]] && out+=(min-fhid)
  (( ${#out[@]} )) && echo "${out[*]}" || echo "none"
}

# axis_between <addr a> <addr b> — 0 when a and b sit side by side (an x cut),
# 1 when stacked (a y cut), ? otherwise. Engine convention (splitTreeOf).
axis_between() {
  local A B
  read -r -a A <<< "$(geo "$1")"; read -r -a B <<< "$(geo "$2")"
  if (( A[0] + A[2] <= B[0] || B[0] + B[2] <= A[0] )); then echo 0
  elif (( A[1] + A[3] <= B[1] || B[1] + B[3] <= A[1] )); then echo 1
  else echo "?"; fi
}

# ------------------------------------------------------------------- stage

echo "=== stage ==="
errs=$(nested configerrors 2>&1 | tr -d '[:space:]')
[[ -z $errs ]] && pass "nested config loaded clean (configerrors blank)" \
  || fail "nested configerrors: $(nested configerrors 2>&1 | head -5)"

FS=$(nested getoption dwindle:force_split -j 2>/dev/null | jq -r '.int // empty')
PS=$(nested getoption dwindle:preserve_split -j 2>/dev/null | jq -r 'if has("int") then .int elif has("bool") then (if .bool then 1 else 0 end) else empty end')
if [[ $FS == 2 && $PS == 1 ]]; then
  note "dwindle: force_split=2 preserve_split=1 already (tests/nested.lua sets them)"
else
  note "dwindle: force_split=$FS preserve_split=$PS — setting Omarchy's: $(nested eval 'hl.config({ dwindle = { force_split = 2, preserve_split = true } })' 2>&1)"
  FS=$(nested getoption dwindle:force_split -j 2>/dev/null | jq -r '.int // empty')
  PS=$(nested getoption dwindle:preserve_split -j 2>/dev/null | jq -r 'if has("int") then .int elif has("bool") then (if .bool then 1 else 0 end) else empty end')
fi
[[ $FS == 2 && $PS == 1 ]] && pass "dwindle force_split=2 preserve_split=1" || fail "dwindle settings are force_split=$FS preserve_split=$PS"
note "monitor $PRIMARY $(nested monitors -j | jq -c --arg m "$PRIMARY" 'first(.[]|select(.name==$m)|{width,height,reserved})')"
note "group:auto_group $(nested getoption group:auto_group -j 2>/dev/null | jq -c .)"

W1=$(ws 1); W2=$(ws 2); W4=$(ws 4); W5=$(ws 5); W6=$(ws 6); W8=$(ws 8); W9=$(ws 9); PARK=$(ws 10)

# HOME: an unwatched window on ws 1 that holds the focus between experiments.
HOME_W=$(spawn home "$W1")
[[ -n $HOME_W ]] || { fail "the home window never appeared"; sandbox_verdict "sandbox-fidelity-probe"; }
focus "$HOME_W"
note "home $HOME_W on ws $(ws_of "$HOME_W"); shown ws $(shown); activewindow $(awc)"

# ---------------------------------------------------------- (a) + (b) group

echo "=== (a)/(b) group ga,gb,gc beside a2 on ws $W2 ==="
A2=$(spawn a2 "$W2")
focus "$A2"
GA=$(spawn ga "$W2"); GB=$(spawn gb "$W2"); GC=$(spawn gc "$W2")
[[ -n $GA && -n $GB && -n $GC ]] || fail "(a) a group member never appeared"
note "group.toggle ga: $(d "hl.dsp.group.toggle({ window = \"address:$GA\" })")"
join "$GB" "$GA" "$GA" || note "WARN gb did not join"
join "$GC" "$GB" "$GA" || note "WARN gc did not join"
note "group order $(group_order "$GA")"
focus "$GB"; focus "$A2"
rects "$W2"

tab_read "a shown, gb last focused" "$GA" "$GB" "$GC"
A_SHOWN1=$TAB_LINE; A_SHOWN1_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")

# (b) on a SHOWN workspace, focus on a2 (not in the group): the selector names gc.
B_ROWS=()
for idx in 0 1 2 3; do
  before="aw $(awc), shown $(shown)"
  ans=$(d "hl.dsp.group.active({ index = $idx, window = \"address:$GC\" })")
  sleep 0.3
  t=$(truth_tab "$GA")
  row="index=$idx -> '$ans', tab now $t, $before -> aw $(awc), shown $(shown)"
  note "b shown: $row"
  B_ROWS+=("$row")
  if [[ $idx == 0 ]]; then
    tab_read "a shown, tab set by group.active (not focus)" "$GA" "$GB" "$GC"
    A_SHOWN2=$TAB_LINE; A_SHOWN2_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")
  fi
done
# Index base, from the order ga,gb,gc: which tab each index produced.
B_IDX0=$(sed -n "s/^index=0 -> .*, tab now \([^,]*\),.*/\1/p" <<< "${B_ROWS[0]}")
B_IDX1=$(sed -n "s/^index=1 -> .*, tab now \([^,]*\),.*/\1/p" <<< "${B_ROWS[1]}")
B_IDX2=$(sed -n "s/^index=2 -> .*, tab now \([^,]*\),.*/\1/p" <<< "${B_ROWS[2]}")

# The same with the selector naming a member and the focus on the group itself —
# to tell "ignores the selector" from "acts on the named group".
focus "$GA"
before="aw $(awc), shown $(shown)"
ans=$(d "hl.dsp.group.active({ index = 2, window = \"address:$GA\" })"); sleep 0.3
B_FOCUSED="group focused (ga), index=2 -> '$ans', tab now $(truth_tab "$GA"), $before -> aw $(awc), shown $(shown)"
note "b: $B_FOCUSED"
# And with no selector at all, focus on a2 (not in a group).
focus "$A2"
ans=$(d "hl.dsp.group.active({ index = 1 })"); sleep 0.3
B_NOSEL="no selector, a2 focused, index=1 -> '$ans', tab now $(truth_tab "$GA")"
note "b: $B_NOSEL"

# Hidden (was shown): home on ws 1.
focus "$GB"; focus "$HOME_W"
tab_read "a hidden (was shown), gb last focused" "$GA" "$GB" "$GC"
A_HIDDEN1=$TAB_LINE; A_HIDDEN1_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")
before="aw $(awc), shown $(shown)"
ans=$(d "hl.dsp.group.active({ index = 0, window = \"address:$GB\" })"); sleep 0.3
B_HIDDEN="hidden ws $W2, index=0 by selector -> '$ans', tab now $(truth_tab "$GA"), $before -> aw $(awc), shown $(shown)"
note "b: $B_HIDDEN"
tab_read "a hidden (was shown), tab set by group.active" "$GA" "$GB" "$GC"
A_HIDDEN2=$TAB_LINE; A_HIDDEN2_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")

# Never shown: carry the whole group to ws 8, which nothing has ever shown.
note "ws $W8 exists before the move? $(nested workspaces -j | jq --argjson w "$W8" 'any(.[]; .id==$w)')"
focus "$GB"; focus "$HOME_W"
mv_ws "$GB" "$W8"; sleep 0.3
note "after window.move(gb -> $W8): ga on $(ws_of "$GA"), gb on $(ws_of "$GB"), gc on $(ws_of "$GC"); shown $(shown)"
rects "$W8"
tab_read "a never shown, gb last focused" "$GA" "$GB" "$GC"
A_NEVER1=$TAB_LINE; A_NEVER1_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")
before="aw $(awc), shown $(shown)"
# An index that is NOT the current tab (Lua's current_index is 1-based), so the
# read below can tell the candidates apart.
cur_idx=$(truth_raw "$GA" | awk '{print $2}'); [[ $cur_idx =~ ^[0-9]+$ ]] || cur_idx=0
nidx=$(( cur_idx % 3 + 1 ))
ans=$(d "hl.dsp.group.active({ index = $nidx, window = \"address:$GA\" })"); sleep 0.3
B_NEVER="never-shown ws $W8, index=$nidx by selector (current_index was $cur_idx) -> '$ans', tab now $(truth_tab "$GA"), $before -> aw $(awc), shown $(shown)"
note "b: $B_NEVER"
tab_read "a never shown, tab set by group.active" "$GA" "$GB" "$GC"
A_NEVER2=$TAB_LINE; A_NEVER2_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")
rects "$W8"

# focus({window}) on a hidden workspace, and refocusing home.
before="aw $(awc), shown $(shown)"
focus "$GA"; sleep 0.2
B_FOCUS="focus(ga) on hidden ws $W8: $before -> aw $(awc), shown $(shown), tab $(truth_tab "$GA")"
focus "$HOME_W"; sleep 0.2
B_FOCUS="$B_FOCUS; then focus(home): aw $(awc), shown $(shown), ws $W8 tab stays $(truth_tab "$GA")"
note "b: $B_FOCUS"
tab_read "a hidden after a focus visit" "$GA" "$GB" "$GC"
A_HIDDEN3=$TAB_LINE; A_HIDDEN3_AGREE=$(agree "$TAB_TRUTH" "$TAB_LINE")

ANSWER[a]="agreeing with Group.current — shown (focus-set): $A_SHOWN1_AGREE; shown (group.active-set): $A_SHOWN2_AGREE; hidden (focus-set): $A_HIDDEN1_AGREE; hidden (group.active-set): $A_HIDDEN2_AGREE; never shown (focus-set): $A_NEVER1_AGREE; never shown (group.active-set): $A_NEVER2_AGREE; hidden after a focus visit: $A_HIDDEN3_AGREE"
[[ $A_SHOWN1 != *"truth(Group.current)=?"* ]] && pass "(a) answered" || fail "(a) Group.current could not be read"

ANSWER[b]="index order ga,gb,gc: index 0 -> $B_IDX0, 1 -> $B_IDX1, 2 -> $B_IDX2 | selector on a2-focused shown ws: ${B_ROWS[0]} | $B_FOCUSED | $B_NOSEL | $B_HIDDEN | $B_NEVER | $B_FOCUS"
[[ -n $B_IDX0 ]] && pass "(b) answered" || fail "(b) no read-back"

# ------------------------------------------------ (e) member-chain arrival

echo "=== (e) member chain on ws $W5: et leader, ea arrives on et, eb on ea, ec on eb, then joins ==="
ET=$(spawn et "$PARK"); EA=$(spawn ea "$PARK"); EB=$(spawn eb "$PARK"); EC=$(spawn ec "$PARK")
[[ -n $ET && -n $EA && -n $EB && -n $EC ]] || fail "(e) a window never appeared"
mv_ws "$ET" "$W5"
focus "$ET"; mv_ws "$EA" "$W5"
E_RECT_T=$(rect "$ET"); E_RECT_A=$(rect "$EA"); read -r -a EAg <<< "$(geo "$EA")"
note "leaders placed: et $E_RECT_T, ea $E_RECT_A (ea's tile is what the group must get back)"
focus "$EA"; mv_ws "$EB" "$W5"
focus "$EB"; mv_ws "$EC" "$W5"
rects "$W5"
note "group.toggle ea: $(d "hl.dsp.group.toggle({ window = \"address:$EA\" })")"
join "$EB" "$EA" "$EA"; E_J1=$JOIN_DIR
note "join eb (pred ea): $E_J1"; rects "$W5"
join "$EC" "$EB" "$EA"; E_J2=$JOIN_DIR
note "join ec (pred eb): $E_J2"; rects "$W5"
focus "$HOME_W"
read -r -a EAn <<< "$(geo "$EA")"
E_ORDER=$(group_order "$EA")
if (( ${#EAg[@]} == 4 && ${#EAn[@]} == 4 )); then
  E_DY=$(( EAn[1] - EAg[1] ))
  if (( EAn[0] == EAg[0] && EAn[2] == EAg[2] && EAn[1] + EAn[3] == EAg[1] + EAg[3] )); then
    E_HOLD="YES — same left, width and bottom edge; the window is inset ${E_DY}px from the top (the groupbar)"
  else
    E_HOLD="NO — ea was $E_RECT_A, the group window is now $(rect "$EA")"
  fi
else
  E_HOLD="unreadable"
fi
E_TSAME=$([[ $(rect "$ET") == "$E_RECT_T" ]] && echo unchanged || echo "CHANGED to $(rect "$ET")")
ANSWER[e]="joins: eb $E_J1, ec $E_J2 (first direction that took; none = would need the scratch fallback) | order $E_ORDER | leader tile holds its rect: $E_HOLD | et $E_TSAME ($E_RECT_T)"
[[ $E_J1 != none && $E_J2 != none ]] && pass "(e) answered: both joins adjacent" || pass "(e) answered (a join needed the scratch fallback)"

# ------------------------------------------------ (d) swap + togglesplit with members

echo "=== (d) swap with a non-active member, togglesplit with a member focused (ws $W5) ==="
D_ACTIVE=$(truth_tab "$EA")
NA=""; for m in "$EA" "$EB" "$EC"; do [[ $(cls_of "$m") != "$D_ACTIVE" ]] && { NA=$m; break; }; done
note "active tab $D_ACTIVE; non-active member used: $(cls_of "$NA")"
D_BEFORE="et $(rect "$ET"), group $(rect "$EA")"
before="aw $(awc), shown $(shown)"
ans=$(d "hl.dsp.window.swap({ window = \"address:$ET\", target = \"address:$NA\" })"); sleep 0.4
rects "$W5"
same_rect=$(cj | jq -r --arg a "$EA" --arg b "$EB" --arg c "$EC" '[.[]|select(.address==$a or .address==$b or .address==$c)|"\(.at)\(.size)"]|unique|length')
D_SWAP1="swap(window=et, target=$(cls_of "$NA")) -> '$ans': before $D_BEFORE; after et $(rect "$ET"), members share $same_rect rect(s) at $(rect "$EA"), tab $(truth_tab "$EA"), $before -> aw $(awc), shown $(shown)"
note "d: $D_SWAP1"
NA2=""; for m in "$EC" "$EB" "$EA"; do [[ $(cls_of "$m") != "$(truth_tab "$EA")" ]] && { NA2=$m; break; }; done
ans=$(d "hl.dsp.window.swap({ window = \"address:$NA2\", target = \"address:$ET\" })"); sleep 0.4
D_SWAP2="swap back (window=$(cls_of "$NA2") non-active, target=et) -> '$ans': et $(rect "$ET"), group $(rect "$EA"), tab $(truth_tab "$EA")"
note "d: $D_SWAP2"
rects "$W5"

D_AXIS0=$(axis_between "$ET" "$EA")
ACT=$(addr_of "$(truth_tab "$EA")")
focus "$ACT"
ans=$(d 'hl.dsp.layout("togglesplit")'); sleep 0.3
D_AXIS1=$(axis_between "$ET" "$EA")
D_TS1="togglesplit, active member $(cls_of "$ACT") focused -> '$ans': et/group axis $D_AXIS0 -> $D_AXIS1; et $(rect "$ET"), group $(rect "$EA")"
note "d: $D_TS1"
NA3=""; for m in "$EA" "$EB" "$EC"; do [[ $m != "$ACT" ]] && { NA3=$m; break; }; done
focus "$NA3"
D_TAB_AFTER_FOCUS=$(truth_tab "$EA")
ans=$(d 'hl.dsp.layout("togglesplit")'); sleep 0.3
D_AXIS2=$(axis_between "$ET" "$EA")
D_TS2="togglesplit, non-active $(cls_of "$NA3") focused (focus made the tab $D_TAB_AFTER_FOCUS) -> '$ans': axis $D_AXIS1 -> $D_AXIS2; et $(rect "$ET"), group $(rect "$EA")"
note "d: $D_TS2"
focus "$HOME_W"
rects "$W5"
ANSWER[d]="$D_SWAP1 | $D_SWAP2 | $D_TS1 | $D_TS2"
[[ $D_AXIS0 != "?" ]] && pass "(d) answered" || fail "(d) rects unreadable"

# ------------------------------------------------ (c) resize a member

echo "=== (c) resize on a group member, near and far side (ws $W5) ==="
# side_of_group — near when the group's tile starts before et's on the cut axis.
C_ROWS=()
resize_case() {   # resize_case <member addr> <label>
  local m="$1" axis g t gn tn cur ask got pos_g pos_t side law
  axis=$(axis_between "$ET" "$EA")
  read -r -a g <<< "$(geo "$m")"; read -r -a t <<< "$(geo "$ET")"
  if [[ $axis == 0 ]]; then cur=${g[2]}; pos_g=${g[0]}; pos_t=${t[0]}; else cur=${g[3]}; pos_g=${g[1]}; pos_t=${t[1]}; fi
  (( pos_g < pos_t )) && side=near || side=far
  ask=$(( cur - 40 ))
  local ans
  if [[ $axis == 0 ]]; then
    ans=$(d "hl.dsp.window.resize({ window = \"address:$m\", x = $ask, y = ${g[3]} })")
  else
    ans=$(d "hl.dsp.window.resize({ window = \"address:$m\", x = ${g[2]}, y = $ask })")
  fi
  sleep 0.4
  read -r -a gn <<< "$(geo "$m")"; read -r -a tn <<< "$(geo "$ET")"
  if [[ $axis == 0 ]]; then got=${gn[2]}; else got=${gn[3]}; fi
  if (( got == ask )); then law="EXACT"
  elif (( got == 2 * cur - ask )); then law="2x-current-minus-asked"
  elif (( got == cur )); then law="NO CHANGE"
  else law="other"; fi
  local others; others=$(cj | jq -r --arg a "$EA" --arg b "$EB" --arg c "$EC" '[.[]|select(.address==$a or .address==$b or .address==$c)|"\(.at)\(.size)"]|unique|length')
  C_ROWS+=("$2 on the $side side (axis $axis): cur $cur ask $ask got $got = $law; et ${t[*]} -> ${tn[*]}; members share $others rect(s); tab $(truth_tab "$EA") -> '$ans'")
  note "c: ${C_ROWS[-1]}"
  sleep 0.2
}
C_ACT=$(addr_of "$(truth_tab "$EA")")
C_NON=""; for m in "$EA" "$EB" "$EC"; do [[ $m != "$C_ACT" ]] && { C_NON=$m; break; }; done
resize_case "$C_ACT" "active $(cls_of "$C_ACT")"
resize_case "$C_NON" "non-active $(cls_of "$C_NON")"
note "swap et with the group leader to change sides: $(d "hl.dsp.window.swap({ window = \"address:$ET\", target = \"address:$EA\" })")"
sleep 0.4
resize_case "$C_ACT" "active $(cls_of "$C_ACT")"
resize_case "$C_NON" "non-active $(cls_of "$C_NON")"
rects "$W5"
# The sign law for a PLAIN window beside the group, for comparison.
read -r -a t <<< "$(geo "$ET")"; C_AX=$(axis_between "$ET" "$EA")
if [[ $C_AX == 0 ]]; then cur=${t[2]}; else cur=${t[3]}; fi
ask=$(( cur - 40 ))
if [[ $C_AX == 0 ]]; then d "hl.dsp.window.resize({ window = \"address:$ET\", x = $ask, y = ${t[3]} })" >/dev/null
else d "hl.dsp.window.resize({ window = \"address:$ET\", x = ${t[2]}, y = $ask })" >/dev/null; fi
sleep 0.4; read -r -a tn <<< "$(geo "$ET")"
if [[ $C_AX == 0 ]]; then got=${tn[2]}; else got=${tn[3]}; fi
C_PLAIN="plain et (pos ${t[0]},${t[1]}): cur $cur ask $ask got $got"
note "c: $C_PLAIN"
ANSWER[c]="$(IFS='|'; echo "${C_ROWS[*]}") | $C_PLAIN"
(( ${#C_ROWS[@]} == 4 )) && pass "(c) answered" || fail "(c) incomplete"

# ------------------------------------------------ (f) arrival axis + togglesplit

echo "=== (f) arrivals f1..f4 on ws $W6, each with focus on its predecessor ==="
F1=$(spawn f1 "$PARK"); F2=$(spawn f2 "$PARK"); F3=$(spawn f3 "$PARK"); F4=$(spawn f4 "$PARK")
[[ -n $F1 && -n $F2 && -n $F3 && -n $F4 ]] || fail "(f) a window never appeared"
mv_ws "$F1" "$W6"
F_ROWS=()
F_TOGGLE=()
arrive() {   # arrive <arrival> <parent>
  local pg ax
  read -r -a pg <<< "$(geo "$2")"
  focus "$2"; mv_ws "$1" "$W6"
  ax=$(axis_between "$2" "$1")
  F_ROWS+=("$(cls_of "$1") on $(cls_of "$2") (tile ${pg[2]}x${pg[3]}, $( (( pg[2] > pg[3] )) && echo wider || echo taller )): axis $ax, $(cls_of "$1") at $(rect "$1"), $(cls_of "$2") now $(rect "$2")")
  note "f: ${F_ROWS[-1]}"
}
# toggle_arrival <arrival> <parent> — togglesplit with the arrival focused;
# what changed, then toggle back.
toggle_arrival() {
  local before after changed ans ax0 ax1
  before=$(cj | jq -c --argjson w "$W6" '[.[]|select(.workspace.id==$w)|{a:.address,at,size}]|sort_by(.a)')
  ax0=$(axis_between "$2" "$1")
  focus "$1"; ans=$(d 'hl.dsp.layout("togglesplit")'); sleep 0.3
  after=$(cj | jq -c --argjson w "$W6" '[.[]|select(.workspace.id==$w)|{a:.address,at,size}]|sort_by(.a)')
  ax1=$(axis_between "$2" "$1")
  changed=$(jq -rn --argjson b "$before" --argjson a "$after" '[range(0; $b|length) as $i | select($b[$i] != $a[$i]) | $b[$i].a]|join(" ")')
  local names=""; for x in $changed; do names+="$(cls_of "$x") "; done
  F_TOGGLE+=("togglesplit with $(cls_of "$1") focused -> '$ans': $(cls_of "$2")/$(cls_of "$1") axis $ax0 -> $ax1; windows that moved: ${names:-none}")
  note "f: ${F_TOGGLE[-1]}"
  d 'hl.dsp.layout("togglesplit")' >/dev/null; sleep 0.3
  note "f: toggled back: axis $(axis_between "$2" "$1")"
}
arrive "$F2" "$F1"
arrive "$F3" "$F2"
toggle_arrival "$F3" "$F2"
arrive "$F4" "$F3"
toggle_arrival "$F4" "$F3"
rects "$W6"
focus "$HOME_W"
ANSWER[f]="$(IFS='|'; echo "${F_ROWS[*]}") | $(IFS='|'; echo "${F_TOGGLE[*]}")"
(( ${#F_ROWS[@]} == 3 )) && pass "(f) answered" || fail "(f) incomplete"

# ------------------------------------------------ (g) modes, float, tags

echo "=== (g) layout modes ==="
note "ws $W9 exists? $(nested workspaces -j | jq --argjson w "$W9" 'any(.[]; .id==$w)')"
G_RULES0=$(nested workspacerules -j 2>&1 | jq -c --arg w "$W9" '[.[]?|select(.workspaceString==$w)]' 2>&1)
note "rule: $(nested eval "hl.workspace_rule({ workspace = \"$W9\", layout = \"scrolling\" })" 2>&1)"
G_RULES1=$(nested workspacerules -j 2>&1 | jq -c --arg w "$W9" '[.[]?|select(.workspaceString==$w)]' 2>&1)
note "workspacerules for $W9 before: $G_RULES0"
note "workspacerules for $W9 after:  $G_RULES1"
note "workspacerules raw keys: $(nested workspacerules -j 2>&1 | jq -c '[.[]?|keys]|unique' 2>&1)"
S1=$(spawn s1 "$W9"); S2=$(spawn s2 "$W9"); S3=$(spawn s3 "$W9")
G_TL9=$(nested workspaces -j | jq -r --argjson w "$W9" 'first(.[]|select(.id==$w)|.tiledLayout)//"absent"')
G_TL5=$(nested workspaces -j | jq -r --argjson w "$W5" 'first(.[]|select(.id==$w)|.tiledLayout)//"absent"')
note "tiledLayout: ws $W9 $G_TL9 (hidden, never shown), ws $W5 $G_TL5"
rects "$W9"
focus "$S2"
note "shown $(shown) after focus s2"; rects "$W9"
G_SC_BEFORE="s1 $(rect "$S1") s2 $(rect "$S2") s3 $(rect "$S3")"
ans=$(d "hl.dsp.window.swap({ window = \"address:$S1\", target = \"address:$S3\" })"); sleep 0.4
G_SWAP="swap(s1,s3) -> '$ans': $G_SC_BEFORE -> s1 $(rect "$S1") s2 $(rect "$S2") s3 $(rect "$S3")"
note "g: $G_SWAP"
read -r -a sg <<< "$(geo "$S2")"
ans=$(d "hl.dsp.window.resize({ window = \"address:$S2\", x = $(( sg[2] - 60 )), y = ${sg[3]} })"); sleep 0.4
G_RESIZE="resize(s2 width ${sg[2]} -> ask $(( sg[2] - 60 ))) -> '$ans': s2 now $(rect "$S2"), s1 $(rect "$S1"), s3 $(rect "$S3")"
note "g: $G_RESIZE"
G_TOGGLE="togglesplit -> '$(d 'hl.dsp.layout("togglesplit")')'"
note "g: $G_TOGGLE"
rects "$W9"
focus "$HOME_W"

echo "=== (g) float on/off, tags ==="
FL=$(spawn fl "$W4")
G_FL=()
for act in on on off off; do
  ans=$(d "hl.dsp.window.float({ window = \"address:$FL\", action = \"$act\" })"); sleep 0.3
  G_FL+=("$act->'$ans' floating=$(cj | jq -r --arg a "$FL" 'first(.[]|select(.address==$a)|.floating)')")
done
note "g: float ${G_FL[*]}"
ans=$(d "hl.dsp.window.tag({ tag = \"+omarchy-floating-workspace\", window = \"address:$FL\" })"); sleep 0.2
G_TAG="window.tag(+omarchy-floating-workspace) -> '$ans': tags $(cj | jq -c --arg a "$FL" 'first(.[]|select(.address==$a)|.tags)')"
note "g: $G_TAG"
# The rule-applied form, for comparison: a rule's tag is listed with a trailing '*'.
note "window rule: $(nested eval "hl.window_rule({ name = \"dr-fp-tagrule\", enabled = true, match = { class = \"^$APP_ID-tg\$\" }, tag = \"+omarchy-floating-workspace\" })" 2>&1)"
TG=$(spawn tg "$W4")
G_RTAG="rule-applied tag: $(cj | jq -c --arg a "$TG" 'first(.[]|select(.address==$a)|.tags)')"
note "g: $G_RTAG"
rects "$W4"

ANSWER[g]="tiledLayout ws $W9 (rule, then windows): $G_TL9; ws $W5: $G_TL5 | workspacerules for a not-yet-existing $W9: before $G_RULES0, after $G_RULES1 | $G_SWAP | $G_RESIZE | $G_TOGGLE | float ${G_FL[*]} | $G_TAG | $G_RTAG"
[[ $G_TL9 != absent ]] && pass "(g) answered" || fail "(g) ws $W9 never appeared"

# ----------------------------------------------------------------- answers

echo "=== ANSWERS (tick ejc) ==="
for k in a b c d e f g; do
  echo "($k) ${ANSWER[$k]:-unanswered}"
done

sandbox_verdict "sandbox-fidelity-probe"
