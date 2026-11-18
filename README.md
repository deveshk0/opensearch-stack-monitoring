# Stack Monitoring for OpenSearch Dashboards

See how your OpenSearch cluster is doing—and where to investigate next—without leaving Dashboards.

[![Checks](https://github.com/deveshk0/opensearch-stack-monitoring/actions/workflows/ci.yml/badge.svg)](https://github.com/deveshk0/opensearch-stack-monitoring/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/deveshk0/opensearch-stack-monitoring)](https://github.com/deveshk0/opensearch-stack-monitoring/releases/latest)
[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Exact host builds](https://img.shields.io/badge/OpenSearch%20Dashboards-exact%20host%20builds-00a4b4)](docs/installation.md#compatibility)

**[Install](#install) · [Try locally](#try-it-locally) · [Documentation](#documentation) · [Contribute](CONTRIBUTING.md)**

![Cluster overview showing health, nodes, indices, and Dashboards metrics](docs/reference/opensearch/02-overview.png)

An independent community plugin for **OpenSearch Dashboards**, distributed as [exact-version builds](docs/installation.md#compatibility). This project is not an official OpenSearch release or affiliated with Elastic.

## What you can do

- **Check cluster health at a glance.** See nodes, indices, shards, JVM heap, storage, and Dashboards traffic in one place.
- **Drill into a problem.** Explore node and index charts, shard allocation and recovery, ingest pipelines, and individual processors.
- **Review operational insights.** Nine checks surface sustained heap, CPU, disk, queue, rejection, shard, and pipeline issues with evidence and suggested next steps.
- **Keep monitoring history.** Collect every ten seconds in the background. Enable or disable self-monitoring from the UI without deleting history.
- **Manage storage automatically.** Monitoring indices use templates, a write alias, ISM rollover, and retention. Resolved insights have their own cleanup policy.
- **Control access.** Separate collector, reader, and manager roles; collector credentials stay on the server.

<details>
<summary>See operational insights</summary>

![Operational insights with evidence and investigation recommendations](docs/reference/opensearch/insights-active.png)

This screenshot comes from a controlled test. Insights suggest investigations; they do not automatically change cluster settings or send notifications.

</details>

## Install

Install the plugin in your **existing OpenSearch Dashboards installation**, restart Dashboards, sign in as a Security administrator, and click **Set up monitoring**. The setup button creates the monitoring resources and a dedicated collector; it needs no collector password entry or host YAML edits.

For a new local cluster, use [Try it locally](#try-it-locally). Install the ZIP in **Dashboards**, not on OpenSearch nodes.

| Requirement | Setup |
| --- | --- |
| Host version | Download the ZIP matching the exact Dashboards version; see [compatibility](docs/installation.md#compatibility) |
| Collection | One attached cluster, one collecting Dashboards instance |
| OpenSearch plugins | Security and Index Management enabled |
| Setup identity | A signed-in Security administrator authorized to create monitoring resources, roles, and internal users |
| Dashboards storage | Writable, persistent `path.data`; use [manual setup](#manual-setup) for externally managed credentials or read-only data storage |
| Connectivity | Existing verified OpenSearch TLS and authentication; keep your secured Dashboards configuration |

### 1. Download and verify

Choose an available tag from [Releases](https://github.com/deveshk0/opensearch-stack-monitoring/releases). `v1.1.0` below is the new feature release example; use it only once published. Select your exact Dashboards version. Use a fresh directory and the same terminal for these commands. The matching checkout provides the Dockerfile and optional manual provisioner; installing a release does **not** require Node or a source build.

```sh
release_tag=v1.1.0 # Choose an available release.
OPENSEARCH_VERSION=3.9.0 # Match your existing OpenSearch/Dashboards deployment.
plugin_asset="stack-monitoring-$OPENSEARCH_VERSION.zip"
git clone --depth 1 --branch "$release_tag" \
  https://github.com/deveshk0/opensearch-stack-monitoring.git
cd opensearch-stack-monitoring
monitoring_checkout="$PWD"
mkdir -p artifacts

curl -fL "https://github.com/deveshk0/opensearch-stack-monitoring/releases/download/$release_tag/$plugin_asset" \
  -o "artifacts/$plugin_asset"
curl -fL "https://github.com/deveshk0/opensearch-stack-monitoring/releases/download/$release_tag/SHA256SUMS" \
  -o artifacts/SHA256SUMS
(
  cd artifacts || exit 1
  awk -v name="$plugin_asset" '$2 == name { print; found++ } END { if (found != 1) exit 1 }' \
    SHA256SUMS > selected-SHA256SUMS &&
    shasum -a 256 -c selected-SHA256SUMS
)
plugin_zip="$PWD/artifacts/$plugin_asset"
```

Continue only if verification reports **your selected ZIP: OK**. Linux users may replace `shasum -a 256` with `sha256sum`. `SHA256SUMS` covers all release assets; filtering the exact filename verifies the one you downloaded without requiring other ZIPs. Plugin release numbers and host versions are separate. The generic `stack-monitoring.zip` asset targets **3.9.0 only**.

### 2. Install and restart Dashboards

Preserve the existing configuration and data directory. Choose the option matching your deployment.

**Debian/RPM package with systemd**

```sh
sudo systemctl stop opensearch-dashboards
cd /usr/share/opensearch-dashboards
sudo bin/opensearch-dashboards-plugin install "file://${plugin_zip}" --single-version strict --allow-root
sudo bin/opensearch-dashboards-plugin list --allow-root
sudo systemctl start opensearch-dashboards
sudo systemctl status opensearch-dashboards --no-pager
```

The plugin list should include **`stackMonitoring@<release-version>`**. For a tarball installation, stop the managed process, run the same plugin commands from its installation directory **as the installation owner**, without `sudo` or `--allow-root`, then restart through your usual process manager.

<details>
<summary><strong>Docker: build a Dashboards image containing the release ZIP</strong></summary>

The Dockerfile expects the verified archive at `artifacts/stack-monitoring.zip`, including when you downloaded a version-specific asset:

```sh
cd "$monitoring_checkout"
cp "artifacts/$plugin_asset" artifacts/stack-monitoring.zip
docker build -f docker/Dockerfile.dashboards \
  --build-arg OPENSEARCH_VERSION="$OPENSEARCH_VERSION" \
  -t "local/stack-monitoring-dashboards:$release_tag-$OPENSEARCH_VERSION" .
```

Use that image for your **existing Dashboards service**. Preserve its connection settings, network, certificates, server credentials, and configured `opensearch_dashboards.yml`. Retain a persistent volume at `/usr/share/opensearch-dashboards/data` (or your configured `path.data`); the collector secret and instance identity must survive replacement. Automatic setup does not require a collector-password environment variable.

Update the image reference in your own Compose file and recreate Dashboards (replace the service name if needed):

```sh
docker compose up -d --no-deps dashboards
docker compose logs --tail=100 dashboards
```

Rebuild for every plugin upgrade; installing into a running container is not persistent. The Dockerfile gives browser assets an archive-specific build identity. The repository's Compose configuration and `docker/opensearch_dashboards.yml` are a local demo with unverified TLS; keep your existing secured configuration for an external cluster.

</details>

### 3. Set up monitoring

1. Sign in as a Security administrator and choose the **Global** tenant.
2. Open **Stack Monitoring** from navigation, or `/app/stackMonitoring` under your Dashboards URL and base path.
3. Open **Set up monitoring** beside the date picker (or **Self-monitoring**), review the explanation, and click **Set up monitoring**.
4. Wait for a successful sample. The UI shows **Waiting for the first collected sample** until collection succeeds. Confirm the last-success time advances, nodes and indices appear, and charts show rates after at least two ten-second samples. Use **Last 15 minutes** when checking fresh data.

Setup uses your current administrator session to create monitoring indices, roles, rollover/retention resources, and a randomly named dedicated collector with a generated password. It stores only that collector's credentials on the Dashboards server, never your administrator password, and starts collection using the host's existing TLS settings. Retrying partial setup reuses its collector account without resetting its password.

The secret is stored at `<path.data>/stack-monitoring/collector.json`, with file mode `0600` and directory mode `0700`. This is filesystem protection, **not encryption**. Protect and back up the data volume; manage disk encryption through your deployment. Setup never edits host YAML. Existing manual collector credentials take precedence, and `stackMonitoring.collection.enabled: false` blocks automatic setup. Use the manual path below when your data directory is read-only or collector identities must be managed externally.

The setup action explicitly enables the saved collection setting. Provisioning resources alone preserves an existing enable/disable choice. Another collector's ownership blocks setup; see [ownership and recovery](docs/installation.md#ownership-and-recovery) before moving collection.

### 4. Give people access

Setup does not grant access to all users. In **Security → Roles → Mapped users**, preserve existing mappings and add your human users or identity-provider backend roles:

| Identity | Monitoring roles |
| --- | --- |
| Viewer | `stack_monitoring_reader` |
| Monitoring operator | `stack_monitoring_reader` **and** `stack_monitoring_manager` |

Human users also need the deployment's usual Dashboards sign-in permissions and **Global** tenant access. The manager role alone does not grant read or sign-in access. Keep the Dashboards server identity separate from the collector. Verify a viewer can read monitoring but cannot change collection; administrators remain responsible for assigning access.

### Manual setup

<details>
<summary><strong>Provision resources, supply a dedicated identity, and configure its server-side secret</strong></summary>

Use this alternative for externally managed identities, custom provisioning options, or data directories where automatic credential storage is unavailable. Complete these steps before restarting the collecting host. Existing manual credentials override automatically stored credentials.

#### Provision storage and roles

From the checked-out repository, run the provisioner against your cluster. Replace the endpoint, CA path, and provisioning username:

```sh
python3 scripts/provision-monitoring.py \
  --url https://cluster.example:9200 \
  --ca-cert /path/to/root-ca.pem \
  --username provisioning-admin \
  --retention-days 7 \
  --replicas 1
```

Enter the provisioning account's password at the prompt. Omit `--ca-cert` when your certificate is trusted by the system CA store. For unattended use, inject `OPENSEARCH_PASSWORD` through your secret manager; do not put passwords in command arguments.

The script creates monitoring roles, templates, the `stack-monitoring-write` alias and backing index, settings/ownership/insight indices, and an ISM policy. Metrics roll over at one day or 20 GiB primary storage; rolled indices become eligible for deletion seven days later. One replica requires at least two data nodes for green monitoring indices; a single-node evaluation can use `--replicas 0`.

Provisioning preserves an existing self-monitoring choice and does **not** create users or role mappings. It updates named monitoring resources, so review retention changes before rerunning it on an installation with history. Keep provisioning privileges separate from the collector account used below.

#### Create a dedicated collector and map roles

While Dashboards is still running, sign in as a Security administrator:

1. Open **Security → Internal users → Create internal user**. Create a dedicated account named `stack_monitoring_collector` with a strong password kept in your secret manager. An existing dedicated identity with username/password authentication can also be used.
2. Open **Security → Roles → stack_monitoring_collector → Mapped users → Manage mapping**. Add that account and save, preserving any existing mappings.
3. Map your human users or identity-provider backend roles as follows:

| Identity | Monitoring roles | Purpose |
| --- | --- | --- |
| Dedicated collector account | `stack_monitoring_collector` | Read statistics and write monitoring data; used only by the Dashboards server |
| Human viewer | `stack_monitoring_reader` | Read metrics, history, and insights |
| Human monitoring operator | `stack_monitoring_reader` **and** `stack_monitoring_manager` | Read monitoring data and toggle self-monitoring |

Human users also need your deployment's usual Dashboards sign-in permissions (for example, `kibana_user`) and access to the **Global** tenant. The reader role includes Global-tenant read access. The manager role alone does not grant read or sign-in access. Keep your existing Dashboards server identity and its roles unchanged; the collector is a separate account. See the [OpenSearch role-mapping guide](https://docs.opensearch.org/3.9/security/access-control/users-roles/) for external identity providers.

#### Configure the collecting process

Add these settings to your existing `opensearch_dashboards.yml`: normally `/etc/opensearch-dashboards/opensearch_dashboards.yml` for packages, or `config/opensearch_dashboards.yml` under a tarball/container installation. Use the dedicated account created above:

```yaml
stackMonitoring.collection.enabled: true
stackMonitoring.collection.username: stack_monitoring_collector
stackMonitoring.collection.password: "${MONITORING_COLLECTOR_PASSWORD}"
stackMonitoring.collection.resolvedRetentionDays: 30
# Optional: show logs from an existing index; this does not install a log shipper.
# stackMonitoring.logs.index: cluster-logs-*
```

The plugin inherits the host's OpenSearch connection and TLS configuration. Keep certificate verification enabled (`opensearch.ssl.verificationMode: full`) and configure `opensearch.ssl.certificateAuthorities` for a private CA. Preserve the existing `opensearch.username` / `opensearch.password` server credentials. Browser access should use HTTPS, directly or through your secured proxy. Optional log access also requires the signed-in user's read permission on that index.

Supply `MONITORING_COLLECTOR_PASSWORD` to the **Dashboards process**, not just your interactive shell. For a systemd package installation:

1. Create `/etc/opensearch-dashboards/stack-monitoring.env` as a root-owned file with mode `0600`, containing the dedicated account's password:

   ```text
   MONITORING_COLLECTOR_PASSWORD=replace-with-the-collector-password
   ```

   Use systemd EnvironmentFile quoting when the password includes whitespace or special characters. Keep this file out of Git.
2. Run `sudo systemctl edit opensearch-dashboards` and add:

   ```ini
   [Service]
   EnvironmentFile=/etc/opensearch-dashboards/stack-monitoring.env
   ```

3. Save the override and run `sudo systemctl daemon-reload`.

For Docker, inject the environment variable through your deployment's secret mechanism. For a tarball, provide it through the process manager that starts Dashboards.

Enable collection on **one instance only**. Set `stackMonitoring.collection.enabled: false` on any other Dashboards instances attached to this cluster. Persist the collecting instance's data directory so its UUID survives restarts; never share or clone that directory between active instances.

Restart Dashboards through your normal process manager, then open **Self-monitoring** and confirm an advancing last-success time. The manual provisioner preserves an existing saved choice; enable collection in the UI if needed.

</details>

### Upgrade or remove

Choose the release and ZIP matching your exact host version, verify its checksum, and preserve configuration, persistent data, and monitoring backups. Read the release's migration instructions; use its matching provisioner only when required resource changes call for it.

For a package installation:

```sh
sudo systemctl stop opensearch-dashboards
cd /usr/share/opensearch-dashboards
sudo bin/opensearch-dashboards-plugin remove stackMonitoring --allow-root
sudo bin/opensearch-dashboards-plugin install "file://${plugin_zip}" --single-version strict --allow-root
sudo systemctl start opensearch-dashboards
```

Tarball owners omit `sudo` and `--allow-root`; Docker deployments rebuild and replace the image. Preserve `path.data` so the stored collector and instance UUID survive. Confirm the installed version, fresh samples, and current browser assets after an upgrade. Invalidate stale proxy/browser assets if necessary.

To uninstall, disable self-monitoring, stop the collecting instance, and remove the plugin or deploy an image without it. Remove any `stackMonitoring.*` configuration before restarting. Plugin removal leaves monitoring indices and the saved collector credential file in place; retire that account and securely remove its secret when no longer needed. Existing ISM policies can still expire metrics, while plugin-driven incident cleanup stops.

### Installation troubleshooting

| Symptom | Check |
| --- | --- |
| Installer rejects compatibility | Select the ZIP for the exact Dashboards host version, not GitHub's source ZIP. |
| Setup unavailable | Sign in as an authorized Security administrator; check the server collection switch and writable persistent data storage. |
| Setup failed | Check Dashboards logs, correct the reported resource/permission/storage problem, and retry. Do not reset the generated account's password. |
| No monitoring data | Check last-success/error status, both collection switches, the time range, and Dashboards logs. Setup completion is not proof of a collected sample. |
| `403` while viewing or toggling | Viewers need reader and Dashboards access; toggling also needs the manager role. |
| Another collector owns the cluster | Stop the former collector and follow [ownership recovery](docs/installation.md#ownership-and-recovery). |
| Manual credentials fail | Verify the collector role mapping and supply `MONITORING_COLLECTOR_PASSWORD` to the service/container, not just your shell. |
| Certificate/hostname error | Use the correct HTTPS endpoint and trusted CA. Keep TLS verification enabled. |

See [Installation and operations](docs/installation.md) for storage, retention, and recovery details.

## Try it locally

The demo starts **three OpenSearch nodes and Dashboards** with the plugin, monitoring roles, and local credentials configured.

You need Docker with Compose, Git, curl, Python 3, and macOS or Linux. Allow about **6 GB for the running stack**, plus memory for the dependency build (Node permits an 8 GB heap). Ports **5602** and **9201** must be available. The first build downloads the official Dashboards source and dependencies.

```sh
git clone https://github.com/deveshk0/opensearch-stack-monitoring.git
cd opensearch-stack-monitoring
bash scripts/bootstrap.sh
bash scripts/start-local.sh
```

1. Open **http://localhost:5602/app/stackMonitoring**.
2. Sign in as **`monitor`**. Find its password under `MONITORING_READER_PASSWORD` in the generated `.opensearch.env` file.
3. Select the **Global** tenant if prompted. Wait for the first samples; charts need consecutive samples before showing rates.

The demo uses demo certificates and unverified TLS on loopback. Keep it local and keep `.opensearch.env` private. For an existing cluster, use the [verified-TLS installation guide](docs/installation.md).

Stop the demo while keeping its data:

```sh
docker compose --env-file .opensearch.env -f compose.opensearch.yml stop
```

## Documentation

| Guide | What you will find |
| --- | --- |
| [Installation and operations](docs/installation.md) | Releases, upgrades, TLS, roles, collector ownership, rollover, retention, and recovery |
| [Self-monitoring](docs/self-monitoring.md) | Enable collection, view its status, and understand stored history |
| [Operational insights](docs/insights.md) | Checks, thresholds, evidence, and incident lifecycle |
| [Contributing](CONTRIBUTING.md) | Build from source, run tests, and write semantic commits |
| [Readiness and limits](docs/production-readiness.md) | Verified behavior and remaining deployment constraints |

## Releases and project status

Successful updates to `main` automatically publish a GitHub release after tests, the official plugin build, and type-checking pass. Releases include host-version-specific installable ZIPs, a SHA-256 checksum manifest, and generated change notes. `feat:` commits increment the minor version; breaking changes increment the major version; other updates increment the patch version. See [release details](CONTRIBUTING.md#releases).

The plugin supports one collecting instance and a maximum chart window of 24 hours. It does not provide automatic collector failover, remote-cluster enrollment, log shipping, or alert delivery. Optional logs require an existing log index. Validate workload capacity, permissions, and recovery in staging; complete cluster outages need independent monitoring.

## Get involved

[Report a bug or suggest an improvement](https://github.com/deveshk0/opensearch-stack-monitoring/issues), or read [CONTRIBUTING.md](CONTRIBUTING.md) to submit a pull request. Include your host version and reproduction steps, and remove credentials and private data from logs.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution; dependencies supplied by Dashboards retain their own licenses.
