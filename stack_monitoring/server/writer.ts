import { createHash } from "crypto";
import type { OpenSearchClient } from "../../../src/core/server";
import type { Entity, Snapshot } from "../common/types";
import { SAMPLE_INTERVAL } from "../common/metrics";
import { record } from "../common/normalize";
export const WRITE_ALIAS = "stack-monitoring-write";
export function displaySnapshot(snapshot: Snapshot): Snapshot {
  const errors = [...snapshot.errors];
  const cap = <T>(items: T[], limit: number, name: string) => {
    if (items.length > limit)
      errors.push(
        `Display limit reached (${limit} ${name}); totals and entity histories include all entities.`,
      );
    return items.slice(0, limit);
  };
  let processorBudget = 500;
  return {
    ...snapshot,
    errors,
    nodes: cap(snapshot.nodes, 100, "nodes"),
    indices: cap(snapshot.indices, 1000, "indices"),
    pipelines: cap(snapshot.pipelines, 500, "pipelines").map((p) => {
      const processors = cap(
        p.processors || [],
        Math.min(100, processorBudget),
        "processors (500 total)",
      );
      processorBudget -= processors.length;
      return { ...p, processors };
    }),
  };
}
export async function writeSnapshot(
  client: OpenSearchClient,
  snapshot: Snapshot,
) {
  if (!snapshot.cluster_uuid.trim() || snapshot.cluster_uuid === "_na_")
    throw new Error("Cluster identity unavailable");
  let body: object[] = [],
    bytes = 0;
  const flush = async () => {
    if (!body.length) return;
    const result = await client.bulk(
      { body, require_alias: true },
      { maxRetries: 0, requestTimeout: 20000 },
    );
    if (record(result.body).errors !== false)
      throw new Error("Monitoring snapshot write rejected");
    body = [];
    bytes = 0;
  };
  const add = async (entity: Entity, payload?: Snapshot) => {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          snapshot.cluster_uuid,
          entity.type,
          entity.id,
          Math.floor(snapshot.timestamp / SAMPLE_INTERVAL),
        ]),
      )
      .digest("hex");
    const pair = [
      { index: { _index: WRITE_ALIAS, _id: id } },
      {
        timestamp: snapshot.timestamp,
        cluster_uuid: snapshot.cluster_uuid,
        type: entity.type,
        entity_id: entity.id,
        name: entity.name,
        status: entity.status,
        metrics: entity.metrics,
        counters: entity.counters,
        ...(payload ? { payload } : {}),
      },
    ];
    const size = Buffer.byteLength(JSON.stringify(pair));
    if (size > 5 * 1024 * 1024)
      throw new Error("Monitoring document exceeds 5 MiB");
    if (body.length >= 1000 || bytes + size > 5 * 1024 * 1024) await flush();
    body.push(...pair);
    bytes += size;
  };
  for (const entities of [
    snapshot.nodes,
    snapshot.indices,
    snapshot.pipelines,
    snapshot.instances,
  ])
    for (const entity of entities) {
      await add(entity);
      for (const processor of entity.processors || []) await add(processor);
    }
  await flush();
  // Publish the summary only after every entity batch has succeeded.
  await add(snapshot.cluster, displaySnapshot(snapshot));
  await flush();
}
