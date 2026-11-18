# Production readiness assessment — 18 November 2026

The plugin has been hardened and exercised on OpenSearch/OpenSearch Dashboards 3.9.0. Treat it as a release candidate for the documented single-collector deployment. This assessment does not certify arbitrary cluster sizes, host versions, security configurations, or availability requirements.

## Changes verified in this pass

- Complete normalization before UI limits; invalid partial sources create gaps instead of inflated rates. Independent valid sources can still produce findings.
- Separate pipeline/processor identities, retained v1 processor charts, disappeared-entity history, fractional metrics, and refresh/save race fixes.
- Retryable settings reads; isolated Insights errors; bounded metric and incident batches; hashed document IDs; summary publication after entity-write success.
- Persistent collector ownership with conditional release and explicit recovery. There is no automatic failover.
- Versioned mappings, required write alias, one primary/one replica by default, ISM rollover at one day or 20 GiB primary size, and seven-day retention after rollover. Existing v1 policies remain unchanged.
- Cluster-scoped, bounded cleanup of resolved incidents after 30 days; active incidents are preserved. Cleanup pauses with collection.
- Operator-only provisioning, verified TLS in the generic provisioner, scoped runtime roles, effective-template and attached-policy checks, and packaged license/notice files.

## Evidence

| Check | Result |
| --- | --- |
| JavaScript/TypeScript regression suite | 96 passing tests on macOS and the official Linux container runtime |
| Provisioning and secure-client tests | 17 passing tests |
| Official host TypeScript check and plugin build | Passed against pinned Dashboards 3.9.0; ZIP manifest, LICENSE and NOTICE validated |
| Local three-node live APIs | Passed health, real rates, entity history, invalid query handling, reader/denied authorization and collector isolation |
| Self-monitoring | Passed enable/disable, stopped sampling, persisted setting across restart and resumed indexing |
| Insights lifecycle | Passed sustained detection, evidence UI, same incident after restart, sustained recovery, mobile view and chart navigation |
| Failure recovery | Passed automatic recovery after settings-access failure; Insights-access failure left metrics running and recovered after permissions returned |
| Installed ownership and cleanup | Passed competing-owner rejection and old-resolved deletion while preserving active, recent and other-cluster fixtures |
| Retained history upgrade | Passed a real v1 processor sample through the final installed API |
| Manual alias rollover | Passed inherited settings, continued writes to the new generation, and retained old history |
| Automatic ISM rollover/deletion | Passed automatic rollover and deletion on the normal scheduler using an isolated policy; current write generation preserved and fixtures removed |
| Browser navigation | Passed overview, nodes, indices, pipelines, processors, Dashboards and instances |
| Credential hygiene | Seven current local credential values absent from release files; this is an exact-value check, not a general secret scan |

The synthetic processing check (`node scripts/benchmark-monitoring.cjs`, after `npm test`) covers 100 nodes, 1,000 indices and 2,000 shards for 20 samples. On this machine it measured approximately 21 ms at p95, four bulk requests and 2.9 MB of encoded requests per sample. It mocks network writes and does not measure indexing throughput, compression, disk growth or sustained production load.

## Remaining deployment limits

- Only OpenSearch Dashboards 3.9.0 has been validated. A [clean Linux bootstrap, test, build, and type-check run](https://github.com/deveshk0/opensearch-stack-monitoring/actions/runs/44307253246) passed on GitHub for commit `382b7f4`. Each automated release requires those checks again for its own revision. CI does not start a live cluster.
- The supplied local Compose deployment uses demo certificates and HTTP browser access. Use verified TLS, protected credentials, appropriate backups and your deployment's access controls in production.
- Only one collector is supported. Persist its unique Dashboards UUID; never clone that data directory into another active collector. A lost owner may require manual recovery after the old process is stopped.
- Self-monitoring cannot independently report a total outage of its own cluster or Dashboards process. Rates are sampled estimates; endpoint response-time variation can affect them.
- The UI caps lists at 100 nodes, 1,000 indices and 500 pipelines; full entity history and totals are collected. Processor display has a total budget of 500. Shard/recovery details are capped with explicit warnings.
- At most 5,000 active incidents can be restored; a larger set fails explicitly. Legacy processor compatibility reads examine more v1 summaries until that history expires.
- No prolonged production workload soak, independent penetration test, general secret-history scanner, or deployment-specific disaster-recovery exercise was performed. Size retention and disk capacity using your real ingestion rate.

## Reproducing live checks

Run these only against the authorized local demo; they create disposable fixtures, and some restart Dashboards or change collection state. Run state-mutating checks sequentially.

```sh
python3 scripts/check-integration.py
python3 scripts/check-self-monitoring.py
node scripts/check-runtime.cjs
python3 scripts/check-failures.py
python3 scripts/check-upgrade.py # requires retained v1 processor history
PLAYWRIGHT_MODULE=/path/to/playwright python3 scripts/check-insights.py
python3 scripts/check-storage.py # normal ISM scheduling can take many minutes
```

The storage test rolls the real monitoring alias once, preserving its history, then verifies automatic rollover and deletion with a unique disposable prefix. It does not change global scheduler settings.

The final extended local run exposed an OpenSearch node OOM at the original 1 GiB container limit; the other two nodes were also near that cap. The demo node limit was raised to 1.5 GiB with its existing 512 MiB JVM heap, and automatic restart was enabled. This is a local resource correction, not production capacity sizing. Rolling recovery was verified: all three nodes returned to green health, retained history and resumed fresh collection without errors.

Final deployed artifact SHA-256: `02f6c61b5510d46fa5d432afbe361689d90eeed922f994ef367a27c6a680aeac`. The running asset build identity was checked against this archive.
