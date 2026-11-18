# Self-monitoring controls

Open **Self-monitoring** beside the date picker to inspect collection status, the history read patterns, the ten-second interval, and the last successful sample. New metrics are written through `stack-monitoring-write`; history reads include v1 and v2 indices. Disabling preserves history under its retention policy.

The choice lives in `.stack-monitoring-settings/_doc/collection`, separate from monitoring history. Provisioning creates the document only when missing and preserves an existing choice. Dashboards reads it before each collection attempt. Missing or unreadable settings prevent collection and expose an error; later attempts retry automatically. Static configuration, collector credentials, storage provisioning, and collection ownership remain prerequisites.

Changes use the signed-in user's OpenSearch client. A reader can inspect the setting; the optional `stack_monitoring_manager` role allows changing it. A read-only account receives 403 on a change. The collector reads the setting but cannot modify it. Runtime changes are serialized and apply only after a successful write. Disabling waits for in-flight work to finish before returning.

Run one collector per cluster, with a unique persisted Dashboards instance UUID. Its cluster-scoped ownership record prevents a different instance from collecting simultaneously; the same UUID can reclaim ownership after restart. There is no automatic ownership expiry or failover. See [installation and recovery](installation.md) before moving a collector to another instance.

Direct external edits are observed on the next collection tick; the plugin endpoint/UI also waits for in-flight writes when disabling. Disabling also pauses incident evaluation and resolved-incident cleanup. Previously recorded findings remain available, with stale active findings shown as unverified.

Unit tests cover denied writes, persistence before runtime changes, invalid saved settings, safe in-flight disable/resume, stale reads, and browser permission errors. `scripts/check-self-monitoring.py` is a separate live check: it changes collection, restarts Dashboards, and leaves collection enabled. Run it only against an authorized test installation.
