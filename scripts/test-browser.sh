#!/bin/sh
set -eu
export XDG_RUNTIME_DIR
XDG_RUNTIME_DIR=$(mktemp -d /tmp/tasm-audio.XXXXXX)
pulseaudio --start --exit-idle-time=-1
trap 'pulseaudio --kill' EXIT
export TASM_TEST_AUDIO=1
if [ "${1:-}" = "--smoke" ]; then
  shift
  set -- --grep @pr "$@"
fi
npm run test:browser -- "$@"
