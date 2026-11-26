#!/bin/sh
set -eu
dist=$(realpath "${TASM_DIST:-dist}")
version=$(node -p 'require("./package.json").version')
archive="tasm-cloudflare-$version.tar.gz"
case "$*" in
  pack)
    # Package only runtime files, excluding local Wrangler state.
    cd "$dist"
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX \
      -czf "$archive" -C cloudflare api/worker.mjs api/tasm.wasm api/wrangler.json \
      auth/worker.mjs auth/operator.mjs auth/wrangler.json auth/migrations LICENSE NOTICE THIRD_PARTY.txt
    sha256sum "$archive" > "$archive.sha256"
    printf '%s\n' "$dist/$archive"
    ;;
  verify)
    (cd "$dist" && sha256sum --strict -c "$archive.sha256")
    mkdir -p .local
    stage=$(mktemp -d "$(pwd)/.local/cloudflare-install.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    mkdir "$stage/cloudflare"
    tar -xzf "$dist/$archive" -C "$stage/cloudflare"
    TASM_DIST="$stage" npm run test:worker
    node -e 'require("node:fs").writeFileSync(process.argv[1], "BETTER_AUTH_SECRET="+require("node:crypto").randomBytes(32).toString("hex"), {mode: 0o600})' "$stage/cloudflare/auth/.dev.vars"
    node "$stage/cloudflare/auth/operator.mjs" schema --config "$stage/cloudflare/auth/wrangler.json" --output "$stage/schema.sql"
    test -s "$stage/schema.sql"
    ;;
  *) echo "Usage: $0 pack|verify" >&2; exit 2 ;;
esac
