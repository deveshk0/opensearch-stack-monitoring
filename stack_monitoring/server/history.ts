import type { OpenSearchClient } from "../../../src/core/server";
import type { Point, Snapshot } from "../common/types";
import {
  historyQuery,
  MONITORING_INDEX,
  parseRange,
  SAMPLE_INTERVAL,
} from "../common/metrics";
import { at } from "../common/normalize";

interface SampleBucket<T> {
  key: number;
  sample: { hits: { hits: Array<{ _source: T }> } };
}

export async function readHistory(
  client: OpenSearchClient,
  query: { from: string; to: string; type: string; id: string },
) {
  const range = parseRange(query.from, query.to);
  await client.transport.request({ method: "GET", path: "/_cluster/health" });
  const info = await client.transport.request({ method: "GET", path: "/" });
  const clusterUuid = at(info.body, "cluster_uuid");
  if (
    typeof clusterUuid !== "string" ||
    !clusterUuid.trim() ||
    clusterUuid === "_na_"
  )
    throw new Error("Cluster identity unavailable");
  const filter = [
    { range: { timestamp: { gte: range.from, lte: range.to } } },
    { term: { cluster_uuid: clusterUuid } },
    { term: { type: "cluster" } },
  ];
  const seriesQuery = historyQuery(range, query.type, query.id);
  const seriesBody = {
    ...seriesQuery,
    query: {
      bool: {
        filter: [
          ...seriesQuery.query.bool.filter,
          { term: { cluster_uuid: clusterUuid } },
        ],
      },
    },
  };
  const request = {
    method: "POST" as const,
    path: `/${MONITORING_INDEX}/_search`,
    querystring: { ignore_unavailable: true, allow_no_indices: true },
  };
  const [latest, history, legacy] = await Promise.all([
    client.transport.request({
      ...request,
      body: {
        size: 1,
        sort: [{ timestamp: "desc" }],
        query: { bool: { filter } },
        _source: ["payload"],
      },
    }),
    client.transport.request({ ...request, body: seriesBody }),
    // V1 processor documents shared pipeline identities; only nested summaries disambiguate them.
    query.type === "processor"
      ? client.transport.request({
          ...request,
          path: "/stack-monitoring-v1-*/_search",
          body: {
            size: 0,
            query: { bool: { filter } },
            aggs: {
              samples: {
                date_histogram: seriesQuery.aggs.samples.date_histogram,
                aggs: {
                  sample: {
                    top_hits: {
                      // V1 stores one cluster summary per ten-second slot; include the whole bucket.
                      size: Math.ceil(range.interval / SAMPLE_INTERVAL) + 1,
                      sort: [{ timestamp: "desc" }],
                      _source: [
                        "timestamp",
                        "payload.pipelines.processors.id",
                        "payload.pipelines.processors.name",
                        "payload.pipelines.processors.status",
                        "payload.pipelines.processors.metrics",
                      ],
                    },
                  },
                },
              },
            },
          },
        })
      : undefined,
  ]);
  if (
    [latest, history, legacy].some(
      (result) =>
        result &&
        (at(result.body, "timed_out") === true ||
          Number(at(result.body, "_shards.failed")) > 0),
    )
  ) {
    throw new Error("Monitoring history search returned incomplete results");
  }
  const hits = at(latest.body, "hits.hits") as
    Array<{ _source: { payload: Snapshot } }> | undefined;
  const buckets = at(history.body, "aggregations.samples.buckets") as
    Array<SampleBucket<Point>> | undefined;
  const points = new Map<number, Point>();
  if (legacy) {
    const legacyBuckets = at(legacy.body, "aggregations.samples.buckets") as
      | Array<
          SampleBucket<{
            timestamp: number;
            payload?: Pick<Snapshot, "pipelines">;
          }>
        >
      | undefined;
    for (const bucket of legacyBuckets ?? []) {
      let point: Point = { timestamp: bucket.key, metrics: {} };
      for (const { _source: source } of bucket.sample.hits.hits) {
        const processor = source?.payload?.pipelines
          ?.flatMap((pipeline) => pipeline.processors ?? [])
          .find((entity) => entity.id === query.id);
        if (processor) {
          point = { timestamp: source.timestamp, metrics: processor.metrics };
          break;
        }
      }
      points.set(bucket.key, point);
    }
  }
  for (const bucket of buckets ?? []) {
    const point = bucket.sample.hits.hits[0]?._source;
    const previous = points.get(bucket.key);
    if (
      point &&
      (!previous ||
        !Object.keys(previous.metrics).length ||
        (Object.keys(point.metrics).length &&
          point.timestamp >= previous.timestamp))
    )
      points.set(bucket.key, point);
    else if (!previous)
      points.set(bucket.key, { timestamp: bucket.key, metrics: {} });
  }
  const snapshot = hits?.[0]?._source.payload ?? null;
  return {
    snapshot: snapshot?.pipelines
      ? {
          ...snapshot,
          pipelines: snapshot.pipelines.map((pipeline) => ({
            ...pipeline,
            processors: pipeline.processors?.map((processor) => ({
              ...processor,
              type: "processor" as const,
            })),
          })),
        }
      : snapshot,
    series: Array.from(points.entries())
      .sort(([left], [right]) => left - right)
      .slice(0, 360)
      .map(([, point]) => point),
    range,
  };
}
