# OpenSearch Dashboards Stack Monitoring

A native plugin for **OpenSearch Dashboards 3.9.0**: cluster, node, index, pipeline, processor, and Dashboards metrics; persistent charts; shard allocation/recovery; and nine advisory operational insight checks.

The supported scope is **one attached cluster and one collecting Dashboards instance**. Other instances can serve the UI with collection disabled. This repository includes a local three-node demonstration and a separate scoped provisioner for existing secured clusters. It does not claim general production readiness or high-availability collection.

- [Installation, TLS, roles, storage, and recovery](docs/installation.md)
- [Self-monitoring controls](docs/self-monitoring.md)
- [Operational insights](docs/insights.md)
- [Contributing and checks](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

Source lives in `stack_monitoring/`. The official build produces `artifacts/stack-monitoring.zip`, containing the plugin, [Apache-2.0 LICENSE](LICENSE), and [NOTICE](NOTICE). Host dependencies are supplied by Dashboards; Elastic Charts has its own separate license. Compatibility is pinned to 3.9.0.

## Local demonstration

Requirements: Docker Compose, Git, curl, Python 3, and sufficient memory for the Dashboards dependency build (Node is allowed an 8 GB heap) and the three-node Docker stack (about 6 GB). Ports 9201 and 5602 must be free. The previously exercised local host is macOS arm64; the new Linux CI workflow must pass for a release before treating Linux builds as verified.

```sh
# Downloads checksum-checked Node 22.23.0 and the exact official host checkout.
bash scripts/bootstrap.sh

# Creates private local credentials, provisions the demo, builds, and starts it.
bash scripts/start-local.sh
```

Open **http://localhost:5602/app/stackMonitoring**. Log in as **monitor** using `MONITORING_READER_PASSWORD` from the private `.opensearch.env` file; select the Global tenant if prompted. The local OpenSearch endpoint is **https://localhost:9201**. Keep generated credentials private.

The Compose example uses bundled demo certificates, unverified TLS, and HTTP browser access on loopback. Do not expose it. For another installation, follow the verified-TLS provisioner and host configuration in [installation](docs/installation.md).

To rebuild the demonstration after source changes:

```sh
# Rerun when monitoring roles, mappings, or retention resources change.
python3 scripts/setup-cluster.py
bash scripts/build-plugin.sh
docker compose --env-file .opensearch.env -f compose.opensearch.yml up -d --build --wait dashboards
```

The custom Docker image derives its asset build number from the plugin ZIP hash so ordinary reloads fetch changed plugin assets. The host checkout, downloaded dependencies, generated credentials, and ZIP are ignored by Git.

Stop without deleting stored history:

```sh
docker compose --env-file .opensearch.env -f compose.opensearch.yml stop
```

## Metrics and operations

The collector samples every ten seconds without overlapping collection requests. Collection continues without a browser. The Self-monitoring control changes a persisted enable/disable setting; disabling preserves retained history. A cluster-scoped ownership record prevents a different Dashboards instance from collecting simultaneously. Persist a unique instance UUID and follow the documented recovery procedure before replacing an owner.

New metrics go through `stack-monitoring-write` to v2 backing indices. ISM rolls them over at one day or 20 GiB primary storage and makes rolled indices eligible for deletion seven days later by default. Legacy v1 history remains readable with its existing policy. Resolved incidents become eligible for cleanup after 30 days by default; active/unverified findings remain. Cleanup requires successful collection. See [storage details](docs/installation.md#storage-and-retention).

Rates use consecutive counter deltas. First samples, resets, gaps, and changed shard assignments produce gaps. Document counts use primaries; primary and total indexing rates remain separate. Charts use the latest sample in each bounded bucket, up to 360 points; tables show the latest snapshot in the selected range. Maximum selectable range is 24 hours. Historical entity charts remain readable when the entity is absent from the latest snapshot. Disk capacity is summed across node filesystems, which may share underlying storage.

Browser APIs use the current user's OpenSearch permissions. Collector credentials remain server-side. A dedicated collector can read statistics and write only named monitoring resources. A monitoring reader can inspect history; the optional manager role changes collection. The generic provisioner creates roles/resources without creating users or altering global Security settings.

Optional logs come from an existing index configured with `stackMonitoring.logs.index`; the signed-in user needs read access. The view shows the latest ten entries in the selected range. No log shipper is included. Insights recommend investigation steps; they do not change cluster settings or deliver notifications. The Alerting link opens the separately installed host app.

## Verification and limits

```sh
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_monitoring*.py'
bash scripts/build-plugin.sh
node .cache/OpenSearch-Dashboards/node_modules/typescript/bin/tsc \
  --project .cache/OpenSearch-Dashboards/plugins/stack_monitoring/tsconfig.json --noEmit
```

Use the pinned Node binary; see [contributing](CONTRIBUTING.md). [CI](.github/workflows/ci.yml) runs unit tests, isolated UI/provisioner tests, official packaging, and type-checking on Linux with pinned toolchain inputs. CI does not start a live cluster.

Historical live/browser evidence is recorded in [verification](docs/verification.md); it does not establish that the current revision or new retention policy has passed live checks. The live scripts can change collection/themes, restart services, and create/delete controlled test data. Read them before running them against an authorized disposable installation.

Display limits are 100 nodes, 1,000 indices, 500 pipelines, 5,000 shard rows, and 500 recovery rows. There is no remote-cluster enrollment, automatic collector failover, log shipping, or alert-delivery engine. The plugin is not a load-tested production monitoring service. Validate actual rollover/deletion, incident cleanup, permissions, recovery, and workload capacity in staging; complete cluster outages require independent monitoring.

See the [production readiness assessment](docs/production-readiness.md) for verified behavior and remaining deployment limits.
