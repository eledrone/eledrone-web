#!/usr/bin/env bash
#
# element-share-audio - route chosen applications' audio into Element Desktop screen shares.
#
# WHY THIS EXISTS
#   The patched client attaches desktop audio to a screen share by capturing an audio
#   *source*. It cannot use a sink's monitor: Chromium filters out any source flagged
#   device.class = "monitor", so monitors are invisible to getUserMedia. A *remapped*
#   source carries no such flag and is enumerated like a normal microphone.
#
#   So setup builds three pieces:
#     1. null sink  "ElementShare"     - applications you want shared are moved here
#     2. remap source "ElementShareMic" (described as "ElementShare") - what the client captures
#     3. loopback ElementShare.monitor -> your real output - so you still hear it
#
#   Only real applications may be moved. Two kinds of stream must never be moved:
#     * Element itself - the call audio would be fed back and remote participants would
#       hear themselves.
#     * The loopback's own playback stream (no owning application) - moving it makes it
#       feed itself, which kills your monitoring path and mangles the audio.
#   This script refuses both, which is the whole reason to use it over raw pactl.
#
# USAGE
#   element-share-audio setup             create the sink/source/loopback
#   element-share-audio list              list movable applications
#   element-share-audio add <app|id>      share that application's audio
#   element-share-audio remove <app|id>   stop sharing it
#   element-share-audio status            show current state
#   element-share-audio teardown          remove everything, restore all streams
#   element-share-audio reset             teardown + setup

set -euo pipefail

SINK_NAME="ElementShare"
SOURCE_NAME="ElementShareMic"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}"
STATE_FILE="$STATE_DIR/element-share-audio.modules"

die() {
    echo "error: $*" >&2
    exit 1
}

command -v pactl >/dev/null || die "pactl not found (install libpulse / pipewire-pulse)"

default_sink() {
    pactl get-default-sink 2>/dev/null || pactl info | sed -n 's/^Default Sink: //p'
}

sink_exists() {
    pactl list short sinks | awk '{print $2}' | grep -qx "$SINK_NAME"
}

source_exists() {
    pactl list short sources | awk '{print $2}' | grep -qx "$SOURCE_NAME"
}

share_sink_index() {
    pactl list short sinks | awk -v n="$SINK_NAME" '$2 == n {print $1}'
}

# index <TAB> sink-index <TAB> application.name   (application.name empty for non-app streams)
stream_table() {
    pactl list sink-inputs | awk '
        function flush() {
            if (idx != "") printf "%s\t%s\t%s\n", idx, sink, app
        }
        /^Sink Input #/ { flush(); idx = substr($3, 2); sink = ""; app = "" }
        /^[[:space:]]*Sink:[[:space:]]/ { sink = $2 }
        /application\.name = / {
            line = $0
            sub(/.*application\.name = "/, "", line)
            sub(/"[[:space:]]*$/, "", line)
            app = line
        }
        END { flush() }
    '
}

# Resolve a user argument (numeric id or case-insensitive app-name substring) to one stream id.
resolve_stream() {
    local want="$1" matches
    if [[ "$want" =~ ^[0-9]+$ ]]; then
        matches="$(stream_table | awk -v i="$want" -F'\t' '$1 == i {print $1}')"
    else
        matches="$(stream_table | awk -v w="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" -F'\t' \
            'tolower($3) ~ w && $3 != "" {print $1}')"
    fi
    [ -n "$matches" ] || die "no audio stream matches '$want' (try: $0 list)"
    [ "$(printf '%s\n' "$matches" | wc -l)" -eq 1 ] ||
        die "'$want' matches several streams: $(echo $matches) - be more specific or use the id"
    printf '%s' "$matches"
}

assert_movable() {
    local id="$1" app
    app="$(stream_table | awk -v i="$id" -F'\t' '$1 == i {print $3}')"

    # No owning application means an internal stream - in practice our own loopback. Moving it
    # into the share sink makes it feed itself: monitor -> loopback -> sink -> monitor.
    [ -n "$app" ] || die "stream $id has no owning application (it is the loopback) - refusing"

    # Element's own output is the call. Sharing it sends remote participants their own voices back.
    case "$(printf '%s' "$app" | tr '[:upper:]' '[:lower:]')" in
        *element*) die "stream $id belongs to '$app' - refusing, this would echo the call back" ;;
    esac
    printf '%s' "$app"
}

record_module() { echo "$1" >> "$STATE_FILE"; }

cmd_setup() {
    if sink_exists && source_exists; then
        echo "already set up; use '$0 status'"
        return 0
    fi
    cmd_teardown >/dev/null 2>&1 || true

    local real_sink
    real_sink="$(default_sink)"
    [ -n "$real_sink" ] || die "could not determine the default sink"
    [ "$real_sink" != "$SINK_NAME" ] || die "default sink is $SINK_NAME; set a real output first"

    : > "$STATE_FILE"

    record_module "$(pactl load-module module-null-sink \
        sink_name="$SINK_NAME" \
        sink_properties=device.description="$SINK_NAME")"

    # A remapped source is NOT flagged as a monitor, so Chromium enumerates it.
    record_module "$(pactl load-module module-remap-source \
        master="${SINK_NAME}.monitor" \
        source_name="$SOURCE_NAME" \
        source_properties=device.description="$SINK_NAME")"

    # Without this you would share the audio but not hear it yourself.
    record_module "$(pactl load-module module-loopback \
        source="${SINK_NAME}.monitor" \
        sink="$real_sink" \
        latency_msec=50)"

    echo "ready: sharing sink '$SINK_NAME', capture source '$SOURCE_NAME' (monitored to $real_sink)"
    echo "next:  $0 list"
}

cmd_list() {
    local found=0
    echo "applications you can share:"
    while IFS=$'\t' read -r id sink app; do
        [ -n "$app" ] || continue
        case "$(printf '%s' "$app" | tr '[:upper:]' '[:lower:]')" in *element*) continue ;; esac
        local mark=""
        [ "$sink" = "$(share_sink_index)" ] && mark="  <- shared"
        printf "  %-6s %s%s\n" "$id" "$app" "$mark"
        found=1
    done < <(stream_table)
    [ "$found" -eq 1 ] || echo "  (nothing playing audio right now - start playback first)"
    echo
    echo "share one with: $0 add <name-or-id>     e.g. $0 add firefox"
}

cmd_add() {
    local want="${1:-}" id app
    [ -n "$want" ] || die "usage: $0 add <app-name-or-id>   (see '$0 list')"
    sink_exists || cmd_setup
    id="$(resolve_stream "$want")"
    app="$(assert_movable "$id")"
    pactl move-sink-input "$id" "$SINK_NAME"
    echo "sharing audio from '$app' (stream $id)"
}

cmd_remove() {
    local want="${1:-}" id
    [ -n "$want" ] || die "usage: $0 remove <app-name-or-id>"
    id="$(resolve_stream "$want")"
    pactl move-sink-input "$id" "$(default_sink)"
    echo "stopped sharing stream $id"
}

cmd_status() {
    if ! sink_exists; then
        echo "not set up - run '$0 setup'"
        echo "(without it the client finds no capture source and shares video only)"
        return 0
    fi
    echo "sink   '$SINK_NAME'    : present"
    echo "source '$SOURCE_NAME' : $(source_exists && echo present || echo MISSING)"
    echo "currently shared:"
    local idx found=0
    idx="$(share_sink_index)"
    while IFS=$'\t' read -r id sink app; do
        [ "$sink" = "$idx" ] || continue
        printf "  %-6s %s\n" "$id" "${app:-(internal stream)}"
        found=1
    done < <(stream_table)
    [ "$found" -eq 1 ] || echo "  (none - use '$0 add <app>')"
}

cmd_teardown() {
    # Return every stream to the real output first, so nothing is briefly silent.
    local idx real
    real="$(default_sink)"
    idx="$(share_sink_index || true)"
    if [ -n "$idx" ] && [ "$real" != "$SINK_NAME" ]; then
        while IFS=$'\t' read -r id sink app; do
            [ "$sink" = "$idx" ] || continue
            pactl move-sink-input "$id" "$real" 2>/dev/null || true
        done < <(stream_table)
    fi

    local ids=""
    [ -f "$STATE_FILE" ] && ids="$(cat "$STATE_FILE")"
    # Fall back to discovering our modules if the state file was lost.
    [ -n "$ids" ] || ids="$(pactl list short modules | awk -v s="$SINK_NAME" -v src="$SOURCE_NAME" '
        $2 == "module-null-sink"    && $0 ~ ("sink_name=" s)      { print $1 }
        $2 == "module-remap-source" && $0 ~ ("source_name=" src)  { print $1 }
        $2 == "module-loopback"     && $0 ~ ("source=" s ".monitor") { print $1 }
    ')"

    # Reverse order: loopback, then remap source, then the sink they depend on.
    for id in $(printf '%s\n' $ids | tac); do
        pactl unload-module "$id" 2>/dev/null || true
    done
    rm -f "$STATE_FILE"
    echo "removed '$SINK_NAME' and restored all streams"
}

case "${1:-}" in
    setup) cmd_setup ;;
    list) cmd_list ;;
    add) cmd_add "${2:-}" ;;
    remove) cmd_remove "${2:-}" ;;
    status) cmd_status ;;
    teardown) cmd_teardown ;;
    reset) cmd_teardown >/dev/null 2>&1 || true; cmd_setup ;;
    *)
        sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
