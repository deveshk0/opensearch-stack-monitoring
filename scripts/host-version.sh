#!/usr/bin/env bash
# Source from build scripts; execute to print the selected host directory.
OSD_VERSION="${OSD_VERSION-3.9.0}"
case "$OSD_VERSION" in
  3.7.0) OSD_COMMIT=dd15c5757c758bc51d8992e979e05f975a605434; NODE_VERSION=22.22.3;;
  3.8.0) OSD_COMMIT=aa72a9818a045ad4e290a5eb9be59e025b90634d; NODE_VERSION=22.23.0;;
  3.9.0) OSD_COMMIT=def668b5c4ad825dfff980ed0951cca07aa0ac4b; NODE_VERSION=22.23.0;;
  3.10.0) OSD_COMMIT=73911ce80af1364fa32301e220ec34910a58c0d3; NODE_VERSION=22.23.4;;
  *) echo "Unsupported OSD_VERSION: $OSD_VERSION (choose 3.7.0, 3.8.0, 3.9.0, or 3.10.0)." >&2; exit 1;;
esac
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OSD_HOST="$project_root/.cache/OpenSearch-Dashboards"
if [[ "$OSD_VERSION" != 3.9.0 ]]; then OSD_HOST="$OSD_HOST-$OSD_VERSION"; fi
case "$(uname -s)" in Darwin) platform=darwin;; Linux) platform=linux;; *) echo 'Use macOS or Linux for the build' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64) arch=x64;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
node_dist="node-v$NODE_VERSION-$platform-$arch"
NODE_BIN="$project_root/.cache/$node_dist/bin"

verify_host() {
  [[ "$(git -C "$OSD_HOST" rev-parse HEAD)" == "$OSD_COMMIT" ]] || { echo "Unexpected Dashboards checkout; expected official $OSD_VERSION ($OSD_COMMIT)." >&2; return 1; }
  [[ "$(cat "$OSD_HOST/.node-version")" == "$NODE_VERSION" ]] || { echo 'Unexpected host Node pin.' >&2; return 1; }
  [[ "$("$NODE_BIN/node" --version)" == "v$NODE_VERSION" ]] || { echo "Run scripts/bootstrap.sh for OSD_VERSION=$OSD_VERSION first." >&2; return 1; }
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then printf '%s\n' "$OSD_HOST"; fi
