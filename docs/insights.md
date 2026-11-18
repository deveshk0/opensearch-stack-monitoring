# Operational insights

Open **Stack Monitoring → Insights** at `http://localhost:5602/app/stackMonitoring#/insights`.

The plugin evaluates new monitoring samples and recommends investigation steps. It makes no changes to cluster settings and does not send telemetry to an external service. These are deterministic heuristics with possible causes, not confirmed root-cause analysis or full Elastic AutoOps parity.

| Check | Initial threshold |
| --- | --- |
| JVM heap pressure | At least 85% used |
| Process CPU pressure | At least 90% |
| Low available disk | At most 10% free |
| Search / write queue | At least 100 queued items, evaluated separately |
| Search / write rejections | Above zero rejections per second, evaluated separately |
| Unassigned shards | Above zero |
| Pipeline failures | Above zero failures per second |

A breach must persist for at least 60 seconds; recovery needs 60 seconds of healthy observations. Gaps over 30 seconds, missing metrics, partial snapshots and relevant node/pipeline resets clear continuity windows. Missing/disappearing entities retain unresolved findings rather than implying recovery. An active finding without a valid observation in 30 seconds is shown as **Unverified**. A fresh collector needs a full detection window before its first finding.

Each finding includes severity, entity, first/last observation, detection and resolution times, the latest breach value and up to seven recent evidence points (including explicit gap markers). Details show possible causes, concrete next steps, official documentation and a link to the relevant monitoring charts. The latter use a bounded absolute time window around the incident; old chart data may have expired while retained breach samples remain available.

The shared time selector finds incidents detected by the end of the window and still open or resolved after its beginning. Status is always the latest known status, not a reconstruction of what the UI would have shown at that past moment. Up to 500 matching findings are returned; the UI explicitly reports truncation. Search and status filters apply to those results.

## Storage and access

Incidents live in `stack-monitoring-insights-v1` with one primary and, by default, one replica. Each episode has a deterministic ID. Updates reuse that ID, recovery records resolution, and recurrence creates a new episode. The collector restores up to 5,000 open incidents after a restart and requires fresh continuity. A larger restore fails explicitly. Exact pending write batches are retried before processing later samples, including partial bulk failures.

The collector gains read/write access only to this additional index. `stack_monitoring_reader` gets read access. The HTTP endpoint uses the current user's OpenSearch permissions, scopes to the connected cluster UUID and rejects incomplete searches. There is no remediation endpoint.

Resolved incidents become eligible for deletion after 30 days by default (`stackMonitoring.collection.resolvedRetentionDays`). Active and unverified findings are retained. Cleanup runs only with enabled, successful metric collection; it processes at most 1,000 resolved documents per pass, normally hourly, and continues on later ticks after a full batch or a failed pass. Monitor index growth and cleanup errors. This is not a separate always-running retention service.

New metrics use v2 rollover indices, deleted seven days after rollover by default; legacy v1 history keeps its existing policy. Metrics can expire while incident evidence remains. See [installation](installation.md) for the alias, rollover, retention, and ownership details.

Insight evaluation and persistence failures are reported separately from successful metric collection. The Insights view warns when current conditions cannot be verified. One collecting Dashboards instance is supported. Detection depends on Dashboards and the monitored cluster being available, so complete cluster outages need independent monitoring.

## Verification

`npm test` covers thresholds, transient suppression, sustained recovery, recurrence, gaps, resets, missing/partial data, restart restoration, permission/query bounds and failed writes. `scripts/check-insights.py` creates a uniquely named temporary index with more replicas than the three nodes can allocate, verifies a real finding and browser evidence, restarts Dashboards to check identity preservation, removes the index and checks resolution. It removes its resolved test incident afterward. Browser screenshots of this controlled test are labeled `insights-active*` and `insights-resolved*`; they are not examples of ongoing production issues.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright python3 scripts/check-insights.py
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-insights.cjs
```

Investigation references: [node statistics](https://docs.opensearch.org/latest/api-reference/nodes-apis/nodes-stats/), [allocation explanations](https://docs.opensearch.org/latest/api-reference/cluster-api/cluster-allocation/), [disk allocation settings](https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/cluster-settings/), and [pipeline simulation](https://docs.opensearch.org/latest/ingest-pipelines/simulate-ingest/).
