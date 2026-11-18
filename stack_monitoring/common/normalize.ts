import type { Entity, MetricMap, RawSnapshot, Snapshot } from "./types";
import {
  counterDelta,
  isInternalIndex,
  operationLatency,
  SAMPLE_INTERVAL,
} from "./metrics";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, key) => record(current)[key], value);
}
export function numberAt(value: unknown, path: string): number | null {
  const result = at(value, path);
  return typeof result === "number" && Number.isFinite(result) && result >= 0
    ? result
    : null;
}
const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const percent = (used: number | null, max: number | null) =>
  used !== null && max !== null && max > 0 ? (used * 100) / max : null;
function sum(values: Array<number | null | undefined>): number | null {
  return values.every((v) => typeof v === "number")
    ? values.reduce<number>((a, b) => a + (b as number), 0)
    : null;
}
function entity(id: string, name: string, type: Entity["type"]): Entity {
  return { id, name, type, status: "unknown", metrics: {}, counters: {} };
}
function indexMetrics(stats: unknown): MetricMap {
  return Object.fromEntries(
    Object.entries({
      docs: "docs.count",
      store: "store.size_in_bytes",
      segments: "segments.count",
      query_cache: "query_cache.memory_size_in_bytes",
      request_cache: "request_cache.memory_size_in_bytes",
      fielddata: "fielddata.memory_size_in_bytes",
      index_writer: "segments.index_writer_memory_in_bytes",
      version_map: "segments.version_map_memory_in_bytes",
      fixed_bitsets: "segments.fixed_bit_set_memory_in_bytes",
    }).map(([key, path]) => [key, numberAt(stats, path)]),
  );
}
function indexCounters(stats: unknown): MetricMap {
  return Object.fromEntries(
    Object.entries({
      search_count: "search.query_total",
      search_time: "search.query_time_in_millis",
      index_count: "indexing.index_total",
      index_time: "indexing.index_time_in_millis",
      throttle_time: "indexing.throttle_time_in_millis",
      merge_count: "merges.total",
      merge_time: "merges.total_time_in_millis",
      refresh_count: "refresh.total",
      refresh_time: "refresh.total_time_in_millis",
      flush_count: "flush.total",
      flush_time: "flush.total_time_in_millis",
    }).map(([key, path]) => [key, numberAt(stats, path)]),
  );
}
export function deriveRates(
  current: Entity,
  previous: Entity | undefined,
  elapsed: number,
) {
  const restarted =
    previous &&
    ((current.generation && current.generation !== previous.generation) ||
      (current.metrics.uptime_ms ?? Infinity) <
        (previous.metrics.uptime_ms ?? 0));
  const before = restarted ? undefined : previous;
  for (const [key, count] of Object.entries(current.counters)) {
    current.metrics[key.replace(/_count$/, "") + "_rate"] = counterDelta(
      count ?? undefined,
      before?.counters[key] ?? undefined,
      elapsed,
    );
  }
  for (const kind of [
    "search",
    "index",
    "index_primary",
    "ingest",
    "gc_young",
    "gc_old",
  ]) {
    current.metrics[kind + "_latency"] = operationLatency(
      current.counters[kind + "_time"] as number,
      before?.counters[kind + "_time"] as number,
      current.counters[kind + "_count"] as number,
      before?.counters[kind + "_count"] as number,
      elapsed,
    );
  }
  return current;
}

export function normalizeSnapshot(
  raw: RawSnapshot,
  previous?: Snapshot,
): Snapshot {
  if (previous?.cluster_uuid !== text(at(raw.info, "cluster_uuid")))
    previous = undefined;
  const elapsed = previous ? raw.timestamp - previous.timestamp : 0;
  const complete = (source: unknown) =>
    source != null &&
    !(Number(at(source, "_nodes.failed")) > 0) &&
    !(Number(at(source, "_shards.failed")) > 0);
  const source_validity = {
    nodeStats: complete(raw.nodeStats),
    indexStats: complete(raw.indexStats),
    health: complete(raw.health),
    shards: Array.isArray(raw.shards),
  };
  const shards = array(raw.shards).map((s) => ({
    index: text(at(s, "index")),
    shard: text(at(s, "shard")),
    primary: at(s, "prirep") === "p",
    state: text(at(s, "state")),
    node: text(at(s, "node"), "Unassigned"),
  }));
  const shardsByIndex = new Map<string, typeof shards>();
  const shardCountsByNode = new Map<string, number>();
  for (const shard of shards) {
    const assigned = shardsByIndex.get(shard.index) || [];
    assigned.push(shard);
    shardsByIndex.set(shard.index, assigned);
    shardCountsByNode.set(
      shard.node,
      (shardCountsByNode.get(shard.node) || 0) + 1,
    );
  }
  const previousNodes = new Map(previous?.nodes.map((e) => [e.id, e]));
  const previousIndices = new Map(previous?.indices.map((e) => [e.id, e]));
  const previousPipelines = new Map(previous?.pipelines.map((e) => [e.id, e]));
  const nodes = Object.entries(record(at(raw.nodeStats, "nodes"))).map(
    ([id, n]) => {
      const e = entity(id, text(at(n, "name"), id), "node");
      e.status = "online";
      e.address = text(at(n, "transport_address"));
      e.version = text(at(record(at(raw.nodeInfo, "nodes"))[id], "version"));
      e.roles = array(at(n, "roles")).filter(
        (role): role is string => typeof role === "string",
      );
      e.metrics = {
        ...indexMetrics(at(n, "indices")),
        uptime_ms: numberAt(n, "jvm.uptime_in_millis"),
        cpu_percent: numberAt(n, "process.cpu.percent"),
        heap_used: numberAt(n, "jvm.mem.heap_used_in_bytes"),
        heap_max: numberAt(n, "jvm.mem.heap_max_in_bytes"),
        disk_available: numberAt(n, "fs.total.available_in_bytes"),
        disk_total: numberAt(n, "fs.total.total_in_bytes"),
        load1: numberAt(n, "os.cpu.load_average.1m"),
        load5: numberAt(n, "os.cpu.load_average.5m"),
        load15: numberAt(n, "os.cpu.load_average.15m"),
        shards: raw.shards ? shardCountsByNode.get(e.name) || 0 : null,
        write_queue: numberAt(n, "thread_pool.write.queue"),
        search_queue: numberAt(n, "thread_pool.search.queue"),
        get_queue: numberAt(n, "thread_pool.get.queue"),
      };
      e.metrics.heap_percent = percent(e.metrics.heap_used, e.metrics.heap_max);
      e.metrics.disk_percent = percent(
        e.metrics.disk_available,
        e.metrics.disk_total,
      );
      e.counters = {
        ...indexCounters(at(n, "indices")),
        gc_young_count: numberAt(n, "jvm.gc.collectors.young.collection_count"),
        gc_young_time: numberAt(
          n,
          "jvm.gc.collectors.young.collection_time_in_millis",
        ),
        gc_old_count: numberAt(n, "jvm.gc.collectors.old.collection_count"),
        gc_old_time: numberAt(
          n,
          "jvm.gc.collectors.old.collection_time_in_millis",
        ),
        io_read_count: numberAt(n, "fs.io_stats.total.read_operations"),
        io_write_count: numberAt(n, "fs.io_stats.total.write_operations"),
        write_rejected_count: numberAt(n, "thread_pool.write.rejected"),
        search_rejected_count: numberAt(n, "thread_pool.search.rejected"),
        get_rejected_count: numberAt(n, "thread_pool.get.rejected"),
        cgroup_throttled_count: numberAt(
          n,
          "os.cgroup.cpu.stat.number_of_times_throttled",
        ),
        cgroup_throttled_time: numberAt(
          n,
          "os.cgroup.cpu.stat.time_throttled_nanos",
        ),
      };
      return deriveRates(e, previousNodes.get(id), elapsed);
    },
  );
  const indices = Object.entries(record(at(raw.indexStats, "indices"))).map(
    ([id, stats]) => {
      const e = entity(id, id, "index");
      const measurements = source_validity.indexStats ? stats : null;
      e.generation = text(at(stats, "uuid"));
      const assigned = shardsByIndex.get(id) || [];
      e.generation +=
        ":" +
        assigned
          .map((s) => `${s.shard}/${s.primary}/${s.state}/${s.node}`)
          .sort()
          .join("|");
      const inactive = (s: (typeof shards)[number]) =>
        s.state !== "STARTED" && s.state !== "RELOCATING";
      e.status =
        source_validity.shards && assigned.length
          ? assigned.some((s) => s.primary && inactive(s))
            ? "red"
            : assigned.some(inactive)
              ? "yellow"
              : "green"
          : "unknown";
      e.metrics = {
        ...indexMetrics(at(measurements, "total")),
        docs: numberAt(measurements, "primaries.docs.count"),
        store_primary: numberAt(measurements, "primaries.store.size_in_bytes"),
        segments_primary: numberAt(measurements, "primaries.segments.count"),
        shards: raw.shards ? assigned.length : null,
        unassigned: raw.shards
          ? assigned.filter((s) => s.state === "UNASSIGNED").length
          : null,
      };
      e.counters = {
        ...indexCounters(at(measurements, "total")),
        index_primary_count: numberAt(
          measurements,
          "primaries.indexing.index_total",
        ),
        index_primary_time: numberAt(
          measurements,
          "primaries.indexing.index_time_in_millis",
        ),
      };
      return deriveRates(e, previousIndices.get(id), elapsed);
    },
  );
  const cluster = entity(
    "cluster",
    text(at(raw.info, "cluster_name"), "OpenSearch"),
    "cluster",
  );
  cluster.version = text(at(raw.info, "version.number"));
  cluster.status = text(at(raw.health, "status"), "unknown");
  const userIndices = indices.filter((e) => !isInternalIndex(e.name));
  const userIndexNames = new Set(userIndices.map((e) => e.name));
  cluster.metrics = {
    nodes: numberAt(raw.health, "number_of_nodes"),
    indices: source_validity.indexStats ? userIndices.length : null,
    all_indices: numberAt(raw.cluster, "indices.count"),
    shards: numberAt(raw.health, "active_shards"),
    primary_shards: numberAt(raw.health, "active_primary_shards"),
    user_primary_shards:
      source_validity.shards && source_validity.indexStats
        ? shards.filter((s) => s.primary && userIndexNames.has(s.index)).length
        : null,
    user_replica_shards:
      source_validity.shards && source_validity.indexStats
        ? shards.filter((s) => !s.primary && userIndexNames.has(s.index)).length
        : null,
    unassigned: numberAt(raw.health, "unassigned_shards"),
    docs: source_validity.indexStats
      ? sum(userIndices.map((e) => e.metrics.docs))
      : null,
    store: source_validity.indexStats
      ? sum(userIndices.map((e) => e.metrics.store))
      : null,
    heap_used: source_validity.nodeStats
      ? sum(nodes.map((e) => e.metrics.heap_used))
      : null,
    heap_max: source_validity.nodeStats
      ? sum(nodes.map((e) => e.metrics.heap_max))
      : null,
    disk_available: source_validity.nodeStats
      ? sum(nodes.map((e) => e.metrics.disk_available))
      : null,
    disk_total: source_validity.nodeStats
      ? sum(nodes.map((e) => e.metrics.disk_total))
      : null,
    uptime_ms: nodes.length
      ? Math.min(...nodes.map((e) => e.metrics.uptime_ms ?? 0))
      : null,
  };
  cluster.metrics.heap_percent = percent(
    cluster.metrics.heap_used,
    cluster.metrics.heap_max,
  );
  cluster.metrics.disk_percent = percent(
    cluster.metrics.disk_available,
    cluster.metrics.disk_total,
  );
  for (const key of [
    "search_count",
    "search_time",
    "index_count",
    "index_time",
    "index_primary_count",
    "index_primary_time",
  ])
    cluster.counters[key] = source_validity.indexStats
      ? sum(userIndices.map((e) => e.counters[key]))
      : null;
  cluster.generation = userIndices
    .map((e) => `${e.id}:${e.generation}`)
    .sort()
    .join("|");
  deriveRates(cluster, previous?.cluster, elapsed);
  const pipelineMap = new Map<string, Entity>();
  const contributors = new Map<string, string[]>();
  const restartedNodes = new Set(
    nodes
      .filter((n) => {
        const before = previousNodes.get(n.id);
        return (
          before &&
          (n.metrics.uptime_ms ?? Infinity) < (before.metrics.uptime_ms ?? 0)
        );
      })
      .map((n) => n.id),
  );
  for (const [nodeId, node] of Object.entries(
    record(at(raw.nodeStats, "nodes")),
  )) {
    for (const [id, stats] of Object.entries(
      record(at(node, "ingest.pipelines")),
    )) {
      let e = pipelineMap.get(id);
      if (!e) {
        e = entity(id, id, "pipeline");
        e.status = "healthy";
        e.metrics = { current: 0 };
        e.counters = { ingest_count: 0, ingest_time: 0, failed_count: 0 };
        e.processors = [];
        pipelineMap.set(id, e);
        contributors.set(id, []);
      }
      contributors.get(id)!.push(nodeId);
      e.metrics.current = sum([e.metrics.current, numberAt(stats, "current")]);
      for (const [key, path] of Object.entries({
        ingest_count: "count",
        ingest_time: "time_in_millis",
        failed_count: "failed",
      }))
        e.counters[key] = sum([e.counters[key], numberAt(stats, path)]);
      array(at(stats, "processors")).forEach((processor, index) => {
        for (const [name, value] of Object.entries(record(processor))) {
          const pid = `${id}/${index}/${name}`;
          let p = e!.processors!.find((v) => v.id === pid);
          if (!p) {
            p = entity(pid, `${index + 1}. ${name}`, "processor");
            p.status = "healthy";
            p.counters = { ingest_count: 0, ingest_time: 0, failed_count: 0 };
            p.metrics = { current: 0 };
            e!.processors!.push(p);
          }
          for (const [key, path] of Object.entries({
            ingest_count: "stats.count",
            ingest_time: "stats.time_in_millis",
            failed_count: "stats.failed",
          }))
            p.counters[key] = sum([p.counters[key], numberAt(value, path)]);
          p.metrics.current = sum([
            p.metrics.current,
            numberAt(value, "stats.current"),
          ]);
        }
      });
    }
  }
  const pipelines = Array.from(pipelineMap.values()).map((e) => {
    if (!source_validity.nodeStats)
      for (const current of [e, ...(e.processors || [])]) {
        current.metrics.current = null;
        for (const key of Object.keys(current.counters))
          current.counters[key] = null;
      }
    const nodeIds = contributors.get(e.id)!;
    e.generation = JSON.stringify(nodeIds.sort());
    const before = nodeIds.some((id) => restartedNodes.has(id))
      ? undefined
      : previousPipelines.get(e.id);
    deriveRates(e, before, elapsed);
    e.processors?.forEach((p) => {
      p.generation = e.generation;
      deriveRates(
        p,
        before?.processors?.find((v) => v.id === p.id),
        elapsed,
      );
      p.status = (p.metrics.failed_rate ?? 0) > 0 ? "warning" : "healthy";
    });
    e.status = (e.metrics.failed_rate ?? 0) > 0 ? "warning" : "healthy";
    return e;
  });
  const instances: Entity[] = [];
  if (raw.dashboards) {
    const d = raw.dashboards;
    const e = entity(raw.instance.id, raw.instance.name, "instance");
    const collected = Date.parse(String(at(d, "collected_at")));
    e.status =
      Number.isFinite(collected) &&
      raw.timestamp - collected <= SAMPLE_INTERVAL * 3
        ? "online"
        : "stale";
    e.version = raw.instance.version;
    e.address = raw.instance.address;
    e.metrics = {
      uptime_ms: numberAt(d, "process.uptime_in_millis"),
      heap_used: numberAt(d, "process.memory.heap.used_in_bytes"),
      heap_max: numberAt(d, "process.memory.heap.size_limit"),
      rss: numberAt(d, "process.memory.resident_set_size_in_bytes"),
      requests: numberAt(d, "requests.total"),
      disconnects: numberAt(d, "requests.disconnects"),
      response_avg: numberAt(d, "response_times.avg_in_millis"),
      response_max: numberAt(d, "response_times.max_in_millis"),
      connections: numberAt(d, "concurrent_connections"),
      load1: numberAt(d, "os.load.1m"),
      load5: numberAt(d, "os.load.5m"),
      load15: numberAt(d, "os.load.15m"),
      event_loop_delay: numberAt(d, "process.event_loop_delay"),
      os_free: numberAt(d, "os.memory.free_in_bytes"),
    };
    e.metrics.heap_percent = percent(e.metrics.heap_used, e.metrics.heap_max);
    instances.push(e);
  }
  const recoveries = array(raw.recovery)
    .slice(0, 500)
    .map((r) => ({
      index: text(at(r, "index")),
      shard: text(at(r, "shard")),
      stage: text(at(r, "stage")),
      source: text(at(r, "source_node")),
      target: text(at(r, "target_node")),
      time: text(at(r, "time")),
      files: text(at(r, "files_percent")),
      bytes: text(at(r, "bytes_percent")),
    }));
  const errors = [...raw.errors];
  if (shards.length > 5000) errors.push("Display limit reached (5000 shards).");
  if (array(raw.recovery).length > 500)
    errors.push("Display limit reached (500 recoveries).");
  return {
    schema: 1,
    timestamp: raw.timestamp,
    cluster_uuid: text(at(raw.info, "cluster_uuid")),
    cluster_name: cluster.name,
    cluster,
    nodes,
    indices,
    pipelines,
    instances,
    shards: shards.slice(0, 5000),
    recoveries,
    errors,
    source_validity,
  };
}
