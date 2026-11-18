# Installing Stack Monitoring

For package, tarball, and Docker commands, follow [Install in the README](../README.md#install). The recommended flow is: install the matching plugin ZIP, restart Dashboards, sign in as a Security administrator, and click **Set up monitoring**. This page covers compatibility, credential storage, manual alternatives, and recovery.

The supported topology is one attached OpenSearch cluster and one collecting Dashboards instance. Other Dashboards instances may serve the UI with collection disabled. Collector ownership is not automatic failover. Validate capacity, recovery, and access controls in your deployment.

## Compatibility

A plugin release number (for example, `v1.1.0`) is separate from its Dashboards host target. Each ZIP targets one **exact** host version; a 3.9.0 ZIP cannot be used as a general 3.x package.

| Exact Dashboards build target | Release asset | New setup runtime validation |
| --- | --- | --- |
| 3.7.0 | `stack-monitoring-3.7.0.zip` | Pending in this development draft |
| 3.8.0 | `stack-monitoring-3.8.0.zip` | Pending in this development draft |
| 3.9.0 | `stack-monitoring-3.9.0.zip` | Pending in this development draft |
| 3.10.0 | `stack-monitoring-3.10.0.zip` | Pending in this development draft |

These are the configured build targets, not a claim that all runtime checks have completed. Consult the selected release's validation notes before deployment. Other host versions are not covered. The generic `stack-monitoring.zip` is an alias of the **3.9.0** archive only.

### OpenSearch 3.7 demo Security configuration

The [3.7 demo mapping](https://github.com/opensearch-project/security/blob/3.7.0.0/config/roles_mapping.yml) grants `own_index` to every user with `users: ["*"]`. That includes a newly generated collector, so automatic setup deliberately refuses to start it. The [3.8 demo mapping](https://github.com/opensearch-project/security/blob/3.8.0.0/config/roles_mapping.yml) removed this default.

Before setup on a cluster retaining that mapping, have its Security administrator replace the wildcard with explicit users or groups that need `own_index`, preserving their intended access. Check other wildcard mappings too: the generated collector must receive only `stack_monitoring_collector`. The plugin does not change global role mappings. After correcting the mapping, retry setup; it reuses the pending identity. This prerequisite applies to the deployment's Security configuration, including clusters upgraded from 3.7.

CI checks that the unmodified 3.7 demo mapping is rejected, then removes it **only in its disposable fixture** before checking successful setup and restart.

## Install a release

Download the matching ZIP and `SHA256SUMS` from an available [GitHub release](https://github.com/deveshk0/opensearch-stack-monitoring/releases). The [README commands](../README.md#1-download-and-verify) use `release_tag=v1.1.0` as the new feature release example; select a published tag. Verify only the selected ZIP, because the checksum manifest contains all host builds:

```sh
plugin_asset=stack-monitoring-3.9.0.zip # Match the exact Dashboards version.
awk -v name="$plugin_asset" '$2 == name { print; found++ } END { if (found != 1) exit 1 }' \
  SHA256SUMS > selected-SHA256SUMS &&
  shasum -a 256 -c selected-SHA256SUMS
```

Run this from the download directory and continue only when the selected ZIP reports `OK`. `sha256sum -c selected-SHA256SUMS` is the Linux alternative. A matching source checkout supplies the optional manual provisioner and Dockerfile; no source build is required for a release install.

Stop Dashboards, preserve its configuration and data directory, and use its plugin installer as the installation owner:

```sh
bin/opensearch-dashboards-plugin install file:///absolute/path/stack-monitoring-3.9.0.zip --single-version strict
```

Use the filename for your host. Package installations and Docker images have different service-management steps; see the [README](../README.md#2-install-and-restart-dashboards). Docker builds require copying the verified versioned archive to `artifacts/stack-monitoring.zip` and selecting the same `OPENSEARCH_VERSION` build argument. Restart Dashboards before opening setup.

For upgrades, remove the old `stackMonitoring` plugin with the host plugin manager before installing the replacement. Preserve the persistent data directory and review release-specific migrations. Removing plugin code does not delete monitoring indices or the stored collector secret. The supplied Docker image derives asset URLs from the ZIP hash; other packaging must likewise ensure browsers fetch upgraded assets.

### Build from source (optional)

Select the exact supported host for both bootstrap and build. Bootstrap selects the host's pinned Node version and official source checkout:

```sh
export OSD_VERSION=3.9.0 # Choose 3.7.0, 3.8.0, 3.9.0, or 3.10.0.
bash scripts/bootstrap.sh
bash scripts/build-plugin.sh
```

The output is `artifacts/stack-monitoring-$OSD_VERSION.zip`. The 3.9.0 build also writes the generic `artifacts/stack-monitoring.zip`; copy other selected builds to that filename before using the repository Dockerfile. A successful build alone does not verify live collection on a deployment.

## Automatic setup

1. Sign in with a Security administrator account authorized to manage monitoring indices, templates, ISM policies, Security roles, and internal users.
2. Choose the **Global** tenant and open **Stack Monitoring**.
3. Open **Set up monitoring** beside the date picker (or **Self-monitoring**) and click **Set up monitoring**.
4. Wait for an advancing last-success time. Setup completion precedes the first sample; rates require consecutive samples.

The plugin uses the current administrator's scoped OpenSearch client to provision monitoring resources and a randomly named dedicated collector with a generated password. The collector gets the scoped monitoring role. The administrator password is not stored, collector credentials never pass through the browser, and setup does not edit `opensearch_dashboards.yml` or alter the host's TLS configuration. Keep certificate/hostname verification enabled and use your existing trusted CA configuration.

The generated credential file is `<path.data>/stack-monitoring/collector.json` with mode `0600`, inside a mode `0700` directory. It is bound to the cluster and collecting Dashboards instance. These permissions provide filesystem protection, **not encryption**. Protect and back up the persistent volume, restrict host access, and manage filesystem/volume encryption separately. Preserve both this file and the Dashboards instance UUID across restart or container replacement; never clone that data directory onto a second active instance.

Setup explicitly enables the saved collection setting and starts the collector. A server setting of `stackMonitoring.collection.enabled: false` blocks it. Existing manually configured credentials override stored automatic credentials. A partial setup can be retried with the same generated collector account without resetting its password; resolve the reported permission/resource/storage problem before retrying. Another instance's ownership blocks setup; use [ownership recovery](#ownership-and-recovery) before moving collection.

Setup does not assign human access globally. Map each viewer to `stack_monitoring_reader`, and each monitoring operator to both `stack_monitoring_reader` and `stack_monitoring_manager`, while preserving existing mappings. Give them the deployment's usual Dashboards sign-in and Global-tenant access separately. The manager role alone is not reader or sign-in access. Optional log views also require the user's read access to the configured log index.

Use the following manual alternative for external identity management or a data directory where automatic credential storage is unavailable.

## Manual provisioning and credentials

Use this alternative when collector identities must be externally managed, automatic setup cannot write its secret under `path.data`, or you need explicit provisioning options. Existing manual credentials take precedence over an automatically stored collector. Use the generic provisioner for an existing secured cluster. It requires HTTPS with certificate and hostname verification; it has no insecure switch and refuses redirects. The CA file may be omitted when the server certificate chains to the system trust store.

```sh
python3 scripts/provision-monitoring.py \
  --url https://cluster.example:9200 \
  --ca-cert /path/to/root-ca.pem \
  --username provisioning-admin
```

The password is prompted securely, or read from `OPENSEARCH_PASSWORD`. Do not put it in command-line arguments. `OPENSEARCH_URL`, `OPENSEARCH_CA_CERT`, and `OPENSEARCH_USERNAME` provide the corresponding defaults. Optional `--retention-days 7` and `--replicas 1` set the metrics policy and the replica count for newly created indices and the template. Existing indices keep their current replica counts. Provisioning changes named monitoring resources; review those names and the retention policy before running it on a cluster with existing monitoring history.

The script installs monitoring roles, index mappings, a write alias and backing index, incident/settings/ownership indices, and an ISM policy. It does **not** create users, change passwords, map identities to roles, or modify global Security configuration. An operator must map existing identities to:

| Role | Intended identity and scope |
| --- | --- |
| `stack_monitoring_collector` | Dedicated server identity: cluster/index statistics, monitoring writes, incident lifecycle, settings reads, and collection ownership. No application-document reads or writes. |
| `stack_monitoring_reader` | Human readers: monitoring history/findings, cluster monitoring, and settings reads. |
| `stack_monitoring_manager` | Optional addition for trusted operators who may change self-monitoring. |

Apply your host's Dashboards/tenant access roles separately. Optional log views require read access to the configured log index. Provisioning privileges belong to an operator, not the long-running collector.

### Configure the manual collector

Configure the host's TLS, authentication, and browser security before enabling collection. In particular, verify OpenSearch certificates with your CA and serve Dashboards through HTTPS with secure session cookies. Keep collector credentials in your secret-management mechanism and pass the password to the server configuration, not to the browser.

The plugin-specific settings are:

```yaml
stackMonitoring.collection.enabled: true
stackMonitoring.collection.username: stack_monitoring_collector
stackMonitoring.collection.password: "${MONITORING_COLLECTOR_PASSWORD}"
stackMonitoring.collection.resolvedRetentionDays: 30
# Optional existing log index; collection does not install a log shipper.
# stackMonitoring.logs.index: cluster-logs-*
```

On every other Dashboards instance connected to the same cluster, set `stackMonitoring.collection.enabled: false`. Persist the collecting host's Dashboards data directory so its instance UUID survives restarts. Each actual instance must have a unique UUID: do not clone a running host's data directory onto another active host.

Restart Dashboards after providing manual credentials. Collection also requires the persisted self-monitoring setting. The UI control beside the date picker changes that setting with the signed-in user's permissions. Disabling preserves retained history. Settings that cannot be read do not silently enable collection.

## Ownership and recovery

Collection uses a cluster-scoped document in `.stack-monitoring-locks-v1`, owned by the Dashboards instance UUID. A different instance cannot collect while another owner holds the document. The same persisted UUID can reclaim ownership after restart. This prevents accidental competing collectors; it is not automatic failover and it cannot distinguish two cloned processes using the same UUID.

Ownership does not expire automatically. If a former collector cannot release its lock, first stop it and verify that it cannot resume. Then use an authorized operator identity to inspect and delete only that cluster's ownership document before starting its replacement. Its ID is the lowercase SHA-256 hex digest of the cluster UUID encoded as UTF-8; the endpoint is `DELETE /.stack-monitoring-locks-v1/_doc/{digest}`. Obtain the cluster UUID from the verified cluster connection, and check the stored owner before deletion. Do not delete the whole ownership index or release a lock while its former process can still collect. Losing a data directory changes the instance UUID and may require this recovery step.

## Storage and retention

| Resource | Behavior |
| --- | --- |
| `stack-monitoring-write` | Write alias, initially backed by `stack-monitoring-v2-000001`. Writes require the alias. |
| `stack-monitoring-v2-*` | ISM rollover at one day or 20 GiB of primary-shard storage. Rolled indices become eligible for deletion seven days after rollover by default. ISM scheduling adds delay; this is not a per-document TTL. |
| `stack-monitoring-v1-*` | Older history remains readable alongside v2. The local demo's existing two-day policy remains unchanged. New collection writes to v2. Processor charts recover legacy values from nested cluster summaries to avoid collisions with old pipeline IDs. |
| `stack-monitoring-insights-v1` | Resolved incidents become eligible for cleanup after 30 days by default. Active/unverified findings are retained. |
| `.stack-monitoring-settings` | Persisted enable/disable setting; separate from history retention. |
| `.stack-monitoring-locks-v1` | Collection ownership; separate from history retention. |

Resolved-incident cleanup runs after successful metric collection, normally hourly, in batches of at most 1,000 resolved documents. A full batch or a failed cleanup is retried on later collection ticks until the backlog is drained. Cleanup pauses while collection is disabled or cannot produce valid writes; it is not an independent scheduled service.

Metrics and incident evidence have independent lifetimes. An old finding can retain breach evidence after its chart history expires. Adjust retention with storage capacity and your data-handling requirements in mind. Check ISM status, available disk, shard health, and collector errors after provisioning; an installed policy alone does not demonstrate that rollover or deletion has executed.

## Verify the installation

After completing automatic or manual setup, sign in as a monitoring reader and open `/app/stackMonitoring`. Confirm that samples advance, the expected nodes/indices appear, rates become available after consecutive samples, and no partial-data or stale warnings persist. Verify a read-only account cannot change self-monitoring and a denied account cannot read history. Test Insights failures independently from metric collection.

An authorized operator can inspect storage in Dashboards **Dev Tools** without changing it:

```http
GET /_cat/aliases/stack-monitoring-write?v
GET /_cat/indices/stack-monitoring-v2-*?v
GET /_plugins/_ism/explain/stack-monitoring-v2-*?show_policy=true
```

Expect the write alias, monitoring backing indices, and the attached `stack-monitoring-v2-retention` policy. Monitoring readers may not have ISM administration permissions.

The repository's isolated tests and exact-host build do not prove live compatibility with your TLS, roles, deployment topology, or workload. Run authorized staging tests and observe actual rollover, retention cleanup, restart identity, and ownership recovery before relying on the installation.

The supplied Compose files and `setup-cluster.py` are a **local demo**: bundled certificates, unverified TLS, HTTP browser access, and demo identities. Their loopback ports must not be exposed as a production deployment.

After changing retention, inspect the policy version and state reported by ISM Explain; managed indices can temporarily retain a cached policy. See the [OpenSearch ISM API](https://docs.opensearch.org/3.9/im-plugin/ism/api/) for explicit policy changes and recovery.
