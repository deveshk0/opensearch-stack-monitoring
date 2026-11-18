#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/host-version.sh
verify_host
export PATH="$NODE_BIN:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
build_root="$OSD_HOST"
mkdir -p "$build_root/plugins/stack_monitoring" "$project_root/artifacts"
rsync -a --delete --exclude build --exclude target --exclude node_modules stack_monitoring/ "$build_root/plugins/stack_monitoring/"
cp LICENSE NOTICE "$build_root/plugins/stack_monitoring/"
cd "$build_root/plugins/stack_monitoring"
node ../../scripts/plugin_helpers build --opensearch-dashboards-version "$OSD_VERSION"
cp "build/stackMonitoring-$OSD_VERSION.zip" "$project_root/artifacts/stack-monitoring-$OSD_VERSION.zip"
python3 - "$project_root" "$OSD_VERSION" <<'PY'
import json
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1])
version = sys.argv[2]
prefix = "opensearch-dashboards/stackMonitoring/"
with zipfile.ZipFile(root / f"artifacts/stack-monitoring-{version}.zip") as archive:
    for name in ("LICENSE", "NOTICE"):
        assert archive.read(prefix + name) == (root / name).read_bytes(), name + " missing or changed in archive"
    manifest = json.loads(archive.read(prefix + "opensearch_dashboards.json"))
    assert manifest["opensearchDashboardsVersion"] == version, "Unexpected host compatibility"
    source_manifest = json.loads((root / "stack_monitoring/opensearch_dashboards.json").read_text())
    assert manifest["version"] == source_manifest["version"], "Unexpected plugin version"
    assert json.loads(archive.read(prefix + "common/setup_resources.json")) == json.loads((root / "stack_monitoring/common/setup_resources.json").read_text()), "Missing or stale setup resource definitions"
    assert not any("/node_modules/" in name for name in archive.namelist()), "Unexpected bundled dependency packages"
print("Archive verified: exact host version, LICENSE, NOTICE, and host-provided dependencies.")
PY
if [[ "$OSD_VERSION" == 3.9.0 ]]; then
  cp "$project_root/artifacts/stack-monitoring-$OSD_VERSION.zip" "$project_root/artifacts/stack-monitoring.zip"
fi
