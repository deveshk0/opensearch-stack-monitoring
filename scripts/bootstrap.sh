#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache
case "$(uname -s)" in Darwin) platform=darwin;; Linux) platform=linux;; *) echo 'Use macOS or Linux for the build'; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64) arch=x64;; *) echo 'Unsupported CPU'; exit 1;; esac
node_dist="node-v22.23.0-$platform-$arch"
if [[ ! -x ".cache/$node_dist/bin/node" ]]; then
  curl -fsSL "https://nodejs.org/dist/v22.23.0/$node_dist.tar.gz" -o ".cache/$node_dist.tar.gz"
  curl -fsSL https://nodejs.org/dist/v22.23.0/SHASUMS256.txt -o .cache/node-shasums.txt
  python3 - "$node_dist" <<'PY'
import hashlib, pathlib, sys
name = sys.argv[1] + '.tar.gz'
expected = next(line.split()[0] for line in pathlib.Path('.cache/node-shasums.txt').read_text().splitlines() if line.endswith('  ' + name))
assert hashlib.sha256(pathlib.Path('.cache', name).read_bytes()).hexdigest() == expected, 'Node checksum mismatch'
PY
  tar -xzf ".cache/$node_dist.tar.gz" -C .cache
fi
export PATH="$PWD/.cache/$node_dist/bin:$PATH"
corepack enable --install-directory "$PWD/.cache/$node_dist/bin"
if [[ ! -d .cache/OpenSearch-Dashboards/.git ]]; then
  git clone --depth 1 --branch 3.9.0 https://github.com/opensearch-project/OpenSearch-Dashboards.git .cache/OpenSearch-Dashboards
fi
[[ "$(git -C .cache/OpenSearch-Dashboards rev-parse HEAD)" == def668b5c4ad825dfff980ed0951cca07aa0ac4b ]] || { echo 'Unexpected Dashboards checkout; expected official 3.9.0.'; exit 1; }
cd .cache/OpenSearch-Dashboards
NODE_OPTIONS=--max-old-space-size=8192 yarn osd bootstrap
