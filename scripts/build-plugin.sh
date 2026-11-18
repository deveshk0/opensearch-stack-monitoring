#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project_root="$PWD"
case "$(uname -s)" in Darwin) platform=darwin;; Linux) platform=linux;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64) arch=x64;; esac
export PATH="$project_root/.cache/node-v22.23.0-$platform-$arch/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
build_root="$project_root/.cache/OpenSearch-Dashboards"
mkdir -p "$build_root/plugins/stack_monitoring" "$project_root/artifacts"
rsync -a --delete --exclude build --exclude target --exclude node_modules stack_monitoring/ "$build_root/plugins/stack_monitoring/"
cp LICENSE NOTICE "$build_root/plugins/stack_monitoring/"
cd "$build_root/plugins/stack_monitoring"
node ../../scripts/plugin_helpers build --opensearch-dashboards-version 3.9.0
cp build/stackMonitoring-3.9.0.zip "$project_root/artifacts/stack-monitoring.zip"
python3 - "$project_root" <<'PY'
import json
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1])
prefix = "opensearch-dashboards/stackMonitoring/"
with zipfile.ZipFile(root / "artifacts/stack-monitoring.zip") as archive:
    for name in ("LICENSE", "NOTICE"):
        assert archive.read(prefix + name) == (root / name).read_bytes(), name + " missing or changed in archive"
    manifest = json.loads(archive.read(prefix + "opensearch_dashboards.json"))
    assert manifest["opensearchDashboardsVersion"] == "3.9.0", "Unexpected host compatibility"
    assert not any("/node_modules/" in name for name in archive.namelist()), "Unexpected bundled dependency packages"
print("Archive verified: exact host version, LICENSE, NOTICE, and host-provided dependencies.")
PY
