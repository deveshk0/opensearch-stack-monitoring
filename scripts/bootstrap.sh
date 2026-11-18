#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/host-version.sh
mkdir -p .cache
if [[ ! -x ".cache/$node_dist/bin/node" ]]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$node_dist.tar.gz" -o ".cache/$node_dist.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o ".cache/$node_dist-shasums.txt"
  python3 - "$node_dist" <<'PY'
import hashlib, pathlib, sys
name = sys.argv[1] + '.tar.gz'
expected = next(line.split()[0] for line in pathlib.Path('.cache', sys.argv[1] + '-shasums.txt').read_text().splitlines() if line.endswith('  ' + name))
assert hashlib.sha256(pathlib.Path('.cache', name).read_bytes()).hexdigest() == expected, 'Node checksum mismatch'
PY
  tar -xzf ".cache/$node_dist.tar.gz" -C .cache
fi
export PATH="$NODE_BIN:$PATH"
corepack enable --install-directory "$NODE_BIN"
if [[ ! -d "$OSD_HOST/.git" ]]; then
  git clone --depth 1 --branch "$OSD_VERSION" https://github.com/opensearch-project/OpenSearch-Dashboards.git "$OSD_HOST"
fi
verify_host
cd "$OSD_HOST"
NODE_OPTIONS=--max-old-space-size=8192 yarn osd bootstrap
