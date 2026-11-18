#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
import os, secrets
path=Path('.opensearch.env')
if not path.exists():
    values={'OPENSEARCH_VERSION':'3.9.0'}
    for key in ['OPENSEARCH_ADMIN_PASSWORD','DASHBOARDS_PASSWORD','MONITORING_COLLECTOR_PASSWORD','MONITORING_READER_PASSWORD','MONITORING_DENIED_PASSWORD']:
        values[key]='Q7!'+secrets.token_hex(20)
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:
        f.write(''.join(k+'='+v+'\n' for k,v in values.items()))
PY
docker compose --env-file .opensearch.env -f compose.opensearch.yml up -d --wait os01 os02 os03
python3 scripts/setup-cluster.py
bash scripts/build-plugin.sh
docker compose --env-file .opensearch.env -f compose.opensearch.yml up -d --build --wait dashboards
printf '%s\n' 'Open http://localhost:5602/app/stackMonitoring and log in as monitor.' 'Password: MONITORING_READER_PASSWORD in .opensearch.env.'
