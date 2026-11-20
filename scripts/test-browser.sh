#!/bin/sh
set -eu
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d /tmp/tasm-audio.XXXXXX)
pulseaudio --start --exit-idle-time=-1
trap 'pulseaudio --kill' EXIT
pactl load-module module-null-sink sink_name=tasm_tests >/dev/null
export PULSE_SINK=tasm_tests TASM_AUDIO_MONITOR=tasm_tests.monitor
if [ "${1:-}" = "--smoke" ]; then
  shift
  set -- core.spec.ts contract.spec.ts recovery.spec.ts onboarding.spec.ts "$@"
fi
npm run test:browser -- "$@"
