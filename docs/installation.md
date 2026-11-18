# Installing Stack Monitoring

The supported scope is one attached OpenSearch cluster and one collecting OpenSearch Dashboards **3.9.0** instance. Other Dashboards instances may serve the UI with collection disabled. This is not an HA collector, a remote-cluster service, or a substitute for independent outage monitoring. Capacity, failure recovery, and your security configuration require validation in your environment.

## Build and install

Use Node 22.23.0 and the exact host checkout selected by `scripts/bootstrap.sh`:

```sh
bash scripts/bootstrap.sh
bash scripts/build-plugin.sh
```

The result is `artifacts/stack-monitoring.zip`. Stop the target Dashboards process, retain its configuration and data directory, and use its plugin installer:

```sh
bin/opensearch-dashboards-plugin install file:///absolute/path/stack-monitoring.zip
```

For an upgrade, remove the existing `stackMonitoring` plugin with the host's plugin manager before installing the replacement. Removing plugin code does not intentionally delete monitoring indices. Retain backups and check storage compatibility before upgrading. The manifest pins 3.9.0; a different host version needs a separate rebuild and verification.

The local Docker image derives asset URLs from the ZIP hash to invalidate long-lived browser caches. Other packaging must also ensure upgraded browser assets are fetched; installing a new ZIP while reusing stale host asset URLs is not sufficient verification.

## Provision storage and roles

Use the generic provisioner for an existing secured cluster. It requires HTTPS with certificate and hostname verification; it has no insecure switch and refuses redirects. The CA file may be omitted when the server certificate chains to the system trust store.

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

## Configure the collecting host

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

Collection also requires the persisted self-monitoring setting. The UI control beside the date picker changes that setting with the signed-in user's permissions. Disabling preserves retained history. Settings that cannot be read do not silently enable collection.

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

After starting Dashboards, sign in as a monitoring reader and open `/app/stackMonitoring`. Confirm that samples advance, the expected nodes/indices appear, rates become available after consecutive samples, and no partial-data or stale warnings persist. Verify a read-only account cannot change self-monitoring and a denied account cannot read history. Test Insights failures independently from metric collection.

The repository's isolated tests and exact-host build do not prove live compatibility with your TLS, roles, deployment topology, or workload. Run authorized staging tests and observe actual rollover, retention cleanup, restart identity, and ownership recovery before relying on the installation.

The supplied Compose files and `setup-cluster.py` are a **local demo**: bundled certificates, unverified TLS, HTTP browser access, and demo identities. Their loopback ports must not be exposed as a production deployment.

After changing retention, inspect the policy version and state reported by ISM Explain; managed indices can temporarily retain a cached policy. See the [OpenSearch ISM API](https://docs.opensearch.org/3.9/im-plugin/ism/api/) for explicit policy changes and recovery.
