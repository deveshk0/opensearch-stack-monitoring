# Self-monitoring controls

After installing the plugin and restarting Dashboards, sign in as a Security administrator and open **Stack Monitoring**. Before collection is configured, the header beside the date picker offers **Set up monitoring**. Open it and click **Set up monitoring** to create the monitoring resources and a scoped collector using your current administrator session. The action explicitly enables collection; it does not ask for a collector password or edit host YAML.

The collector receives a generated password stored only on the server at `<path.data>/stack-monitoring/collector.json` (file mode `0600`, directory mode `0700`). No administrator password is saved. File permissions are not encryption: protect and back up the persistent data volume. See [automatic setup](installation.md#automatic-setup) for storage requirements, access mapping, and the manual alternative.

Setup completion is not proof of collection. The UI displays **Waiting for the first collected sample** until a successful sample exists. Confirm the last-success time advances and allow consecutive samples before expecting rate charts. A failed setup can be retried; partial setup reuses the generated account without resetting its password. A reader sees why setup is unavailable instead of receiving an administrator action.

Once configured, open **Self-monitoring** to inspect collection status, history read patterns, the ten-second interval, and the last successful sample. New metrics are written through `stack-monitoring-write`; history includes v1 and v2 indices. Disabling preserves history under its retention policy.

The saved choice lives in `.stack-monitoring-settings/_doc/collection`, separate from monitoring history. Resource provisioning alone creates that document only when missing and preserves an existing choice; clicking **Set up monitoring** explicitly enables it. Dashboards reads the setting before each collection attempt. Missing or unreadable settings prevent collection and expose an error; later attempts retry automatically.

The server switch `stackMonitoring.collection.enabled: false` prevents collection and automatic setup. Existing manual collector credentials take precedence over automatically stored credentials. Use [manual provisioning and credentials](installation.md#manual-provisioning-and-credentials) when identities must be managed externally or automatic storage is unavailable.

Collection changes use the signed-in user's OpenSearch client. A viewer needs `stack_monitoring_reader` plus the deployment's Dashboards access. An operator additionally needs `stack_monitoring_manager`; this role alone does not grant reader or sign-in access. Setup does not give monitoring access to all users. A read-only account receives 403 when changing collection. The collector reads the setting but cannot modify it. Runtime changes are serialized and apply only after a successful write. Disabling waits for in-flight work to finish before returning.

Run one collector per cluster, with a unique persisted Dashboards instance UUID. Its ownership record blocks another instance from setting up or collecting simultaneously; the same UUID can reclaim ownership after restart. Preserve `path.data`, including the stored collector secret, and never clone it onto another active instance. There is no automatic ownership expiry or failover. See [ownership and recovery](installation.md#ownership-and-recovery) before moving a collector.

Direct external setting edits are observed on the next collection tick; the plugin endpoint/UI also waits for in-flight writes when disabling. Disabling pauses incident evaluation and resolved-incident cleanup. Recorded findings remain available, with stale active findings shown as unverified.

`scripts/check-self-monitoring.py` is a separate live check: it changes collection, restarts Dashboards, and leaves collection enabled. Run it only against an authorized test installation. The [compatibility table](installation.md#compatibility) tracks the current development targets; build and isolated tests alone do not establish live runtime compatibility.
