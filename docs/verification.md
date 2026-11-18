# Verification and implementation decisions

The implementation was checked in native OpenSearch Dashboards 3.9.0 on a three-node local OpenSearch cluster. Reference screenshots came from a running Kibana instance; this is an independent implementation of the observed workflows.

- Unit suite: 46 passing tests for rates, resets/relocation, node contributors, normalization, time bounds, scoped history, partial search failures, collector lifecycle and deep links.
- Official plugin-helper build and TypeScript checks pass. The generated zip is installed in the matching Docker image.
- Live checks pass for three green nodes, persisted samples, real indexing/search/pipeline activity, reader and denied accounts, collector write isolation, invalid ranges and absolute windows. Historical samples survived a Dashboards restart.
- Browser evidence is stored in `reference/opensearch/`; `verification.json` records the checked routes and interactions. Dark-mode and denied-reader captures are separate. Time-picker selection and refresh start/stop were exercised through the native controls.

An independent review found two important issues: pipeline rates could spike when a node returned/reset, and a partial history search could be mistaken for empty history. Both were reproduced with failing tests and fixed; the full test suite passes afterward. No remaining critical/important findings or deferred minor findings were reported.

The restricted reader can cause the host Data Connections plugin's background `/api/dataconnections` probe to log HTTP 403/Forbidden. Monitoring's own requests succeed. The browser check records this known host warning separately and fails on unexpected monitoring requests/errors.

Implementation decisions:

1. Work continued under the user's explicit approval; the empty workspace received its own feature branch. No existing branch was displaced.
2. OpenSearch reserves the built-in Dashboards server role. The setup creates an equivalent dedicated role and configures Security's service username through its supported administration tool.
3. Table filtering uses a native plain-text search field with in-memory filtering, avoiding a query-language parser for name/address searches and supporting paste.
4. Single-cluster collection, demo TLS, display caps and untested long-running retention/load behavior remain explicit limits. Production TLS and collector election require separate work.
5. The unrelated Data Connections warning is retained instead of expanding the monitoring reader's privileges.

The setup/download paths are verified on macOS arm64. Linux/x64 paths, production-scale performance, multi-instance collection and two-day retention expiry were not tested. No log shipper or alert-delivery integration was configured.

## Layout follow-up

The date/time toolbar, including Refresh, is capped at 560 px and right-aligned on desktop. Summary cards align at desktop/tablet widths and stack on mobile. The revised native design uses a quiet health strip, section icons, count badges and compact metric rows. Navigation resets scroll only when changing views, preserving scroll during refresh and filtering.

The user-index summary now counts primary and replica shards from the same index set as documents/storage; cluster-wide shard totals remain in the health strip. A regression test and live persisted-data check verify this distinction. `scripts/check-layout.cjs` checks 1892, 1600, 1024 and 390 px widths, desktop fit, card alignment, the 560 px toolbar cap and scroll reset. Full browser interactions and dark mode were also rechecked.

## Cached-browser update fix

The official distribution serves JavaScript with a one-year cache lifetime under URLs containing its build number (9054). Replacing the plugin while retaining that build number left existing browsers on old chunks, although clean-browser screenshots showed the new design. The custom Docker image now derives a safe numeric build ID from the plugin ZIP SHA-256.

A browser session was warmed on build 9054, held open through deployment, and reloaded normally. It fetched `/140393361677131/bundles/plugin/stackMonitoring/stackMonitoring.chunk.0.js` and displayed the 560 px toolbar. No browser storage was cleared. `scripts/check-cache-update.cjs` verifies the deployment identity; `WAIT_FOR_REDEPLOY=1` holds a warmed browser across a deployment for the regression check.

## Status alignment and self-monitoring control

The health label inherited a 15.75 px host style while the neighboring status text was 14 px, and the flex row stretched its children. The strip now shares the same font/line height and centers its items. The layout check compares actual text rectangles, with a one-pixel tolerance.

Self-monitoring can now be toggled from the toolbar. Six additional tests cover persisted settings, denied writes and in-flight pause/resume. The live test confirms read-only refusal, sample cessation, disabled state across restart and resumed indexing. A focused independent review found no important/critical issues within the single-instance scope. Collection is left enabled.


## Recommendation-only Insights

Nine heuristic checks evaluate sustained resource pressure, thread-pool queues/rejections, unassigned shards and pipeline failures. Detection and recovery each require one minute of valid observations. Findings persist in a separately permissioned index and preserve evidence and lifecycle timestamps.

Fourteen focused tests cover boundaries, transient suppression, recovery/recurrence, missing/partial samples, gaps/resets, restore, bounded and scoped reads and failed writes. Independent review reproduced two important issues: a partially successful bulk write could orphan an incident after a gap, and unrelated cluster topology changes could suppress the unassigned-shard gauge. Both received failing regression tests and fixes; the full 46-test suite passes. Pending transitions are now retried exactly before later samples; topology changes do not reset the cluster gauge.

See [Insights](insights.md) for retention, single-collector and heuristic limitations and the controlled live-test procedure. No resource-exhaustion test is used: the live check creates only its own temporary empty index, then removes it and its resolved incident record.

The real restart test also caught a loss of pre-restart chart evidence. A failing regression test now verifies preserved evidence through recovery and an explicit null point across an observation gap. The detail chart uses the full flyout width.

Live validation passed for real sustained detection, persisted evidence, restart identity preservation, recovery and resolved-history browser details. The uniquely named temporary index and its resolved finding were removed, returning the cluster to green. The full existing route suite and responsive layout checks also pass. One test run was interrupted by host sleep; the fresh run used a process-scoped idle-sleep assertion and passed without changing detection/recovery thresholds.

Native dark-theme checks pass for both monitoring and Insights; the original theme was restored.
