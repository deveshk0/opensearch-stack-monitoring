import type { OpenSearchClient } from "../../../src/core/server";
import { createHash } from "crypto";
import { at, record } from "../common/normalize";
import {
  INSIGHT_RULES,
  INSIGHT_WINDOW,
  INSIGHTS_INDEX,
  Insight,
} from "../common/insights";
import type { Snapshot } from "../common/types";
import { SAMPLE_INTERVAL, parseRange } from "../common/metrics";
const requestOptions = { maxRetries: 0, requestTimeout: 20000 };
interface Window {
  incident?: Insight;
  since?: number;
  healthySince?: number;
  last?: number;
  uptime?: number | null;
  generation?: string;
  evidence?: Insight["evidence"];
}
const keyFor = (cluster: string, rule: string, entity: string) =>
  JSON.stringify([cluster, rule, entity]);
export class InsightTracker {
  private windows = new Map<string, Window>();
  restore(incidents: Insight[]) {
    this.windows = new Map(
      incidents.map((incident) => [
        keyFor(incident.cluster_uuid, incident.rule_id, incident.entity_id),
        { incident },
      ]),
    );
  }
  evaluate(snapshot: Snapshot) {
    const next = new Map<string, Window>();
    const changes: Insight[] = [];
    // Missing observations retain unresolved incidents without counting toward recovery.
    for (const [key, window] of this.windows)
      if (window.incident) next.set(key, { incident: window.incident });
    for (const rule of INSIGHT_RULES) {
      const valid = snapshot.source_validity
        ? snapshot.source_validity[
            rule.type === "cluster" ? "health" : "nodeStats"
          ]
        : !snapshot.errors.length;
      if (!valid) continue;
      const entities =
        rule.type === "node"
          ? snapshot.nodes
          : rule.type === "pipeline"
            ? snapshot.pipelines
            : [snapshot.cluster];
      for (const entity of entities) {
        const value = entity.metrics[rule.metric];
        if (value == null || !Number.isFinite(value) || value < 0) continue;
        const key = keyFor(snapshot.cluster_uuid, rule.id, entity.id);
        const previous = this.windows.get(key);
        const t = snapshot.timestamp;
        const uptime = entity.metrics.uptime_ms;
        const continuous =
          previous?.last !== undefined &&
          t > previous.last &&
          t - previous.last <= SAMPLE_INTERVAL * 3 &&
          (entity.type === "cluster" ||
            previous.generation === entity.generation) &&
          !(
            uptime != null &&
            previous.uptime != null &&
            uptime < previous.uptime
          );
        const window: Window = continuous
          ? { ...previous }
          : { incident: previous?.incident };
        window.last = t;
        window.uptime = uptime;
        window.generation = entity.generation;
        const breached =
          rule.operator === ">="
            ? value >= rule.threshold
            : rule.operator === "<="
              ? value <= rule.threshold
              : value > rule.threshold;
        if (breached) {
          window.healthySince = undefined;
          window.since = window.since ?? t;
          const evidence = window.incident?.evidence || window.evidence || [];
          const last = evidence[evidence.length - 1];
          window.evidence = [
            ...evidence,
            ...(last && t - last.timestamp > SAMPLE_INTERVAL * 3
              ? [{ timestamp: t - 1, value: null }]
              : []),
            { timestamp: t, value },
          ].slice(-7);
          if (!window.incident && t - window.since >= INSIGHT_WINDOW) {
            window.incident = {
              id: createHash("sha256")
                .update(
                  JSON.stringify([
                    snapshot.cluster_uuid,
                    rule.id,
                    entity.id,
                    window.since,
                  ]),
                )
                .digest("hex"),
              cluster_uuid: snapshot.cluster_uuid,
              rule_id: rule.id,
              entity_id: entity.id,
              entity_name: entity.name,
              entity_type: entity.type,
              severity: rule.severity,
              status: "active",
              first_seen: window.since,
              detected_at: t,
              last_seen: t,
              last_evaluated: t,
              resolved_at: null,
              value,
              evidence: window.evidence,
            };
          }
          if (window.incident)
            window.incident = {
              ...window.incident,
              last_seen: t,
              value,
              evidence: window.evidence,
            };
        } else {
          window.since = undefined;
          window.evidence = [];
          window.healthySince = window.healthySince ?? t;
        }
        if (window.incident) {
          const resolved =
            !breached && t - window.healthySince! >= INSIGHT_WINDOW;
          const incident: Insight = {
            ...window.incident,
            entity_name: entity.name,
            last_evaluated: t,
            status: resolved ? "resolved" : "active",
            resolved_at: resolved ? t : null,
          };
          changes.push(incident);
          window.incident = resolved ? undefined : incident;
        }
        if (window.incident || breached) next.set(key, window);
        else next.delete(key);
      }
    }
    return {
      changes,
      commit: () => {
        this.windows = next;
      },
    };
  }
}

// shortcut: one collecting Dashboards instance; add leader election before running multiple collectors.
export class InsightStore {
  private tracker = new InsightTracker();
  private cluster?: string;
  private pending?: ReturnType<InsightTracker["evaluate"]> & {
    timestamp: number;
  };
  private lastCleanup?: number;
  constructor(
    private client: OpenSearchClient,
    private resolvedRetentionDays = 30,
  ) {
    if (!Number.isInteger(resolvedRetentionDays) || resolvedRetentionDays < 1)
      throw new Error("Insight retention must be a positive number of days");
  }
  async collect(snapshot: Snapshot) {
    clusterIdentity(snapshot.cluster_uuid);
    if (this.cluster !== snapshot.cluster_uuid) {
      this.pending = undefined;
      this.cluster = undefined;
      const saved = await searchInsights(
        this.client,
        [
          { term: { cluster_uuid: snapshot.cluster_uuid } },
          { term: { status: "active" } },
        ],
        5000,
      );
      // shortcut: restore at most 5000 open incidents; paginate before supporting larger incident sets.
      if (saved.total > 5000)
        throw new Error("Open incident restore limit exceeded");
      this.tracker.restore(saved.incidents);
      this.cluster = snapshot.cluster_uuid;
      this.lastCleanup = undefined;
    }
    if (this.pending) {
      const timestamp = this.pending.timestamp;
      await this.flush();
      if (snapshot.timestamp <= timestamp) {
        await this.cleanup(snapshot.timestamp);
        return;
      }
    }
    this.pending = {
      ...this.tracker.evaluate(snapshot),
      timestamp: snapshot.timestamp,
    };
    await this.flush();
    await this.cleanup(snapshot.timestamp);
  }
  private async cleanup(timestamp: number) {
    if (
      this.lastCleanup !== undefined &&
      timestamp - this.lastCleanup < 3600000
    )
      return;
    const result = await this.client.transport.request(
      {
        method: "POST",
        path: `/${INSIGHTS_INDEX}/_delete_by_query`,
        querystring: { conflicts: "proceed", max_docs: 1000 },
        body: {
          query: {
            bool: {
              filter: [
                { term: { status: "resolved" } },
                { term: { cluster_uuid: this.cluster } },
                {
                  range: {
                    resolved_at: {
                      lt: timestamp - this.resolvedRetentionDays * 86400000,
                    },
                  },
                },
              ],
            },
          },
        },
      },
      requestOptions,
    );
    const deleted = at(result.body, "deleted");
    const failures = at(result.body, "failures");
    if (
      typeof deleted !== "number" ||
      !Number.isFinite(deleted) ||
      deleted < 0 ||
      at(result.body, "timed_out") !== false ||
      Number(at(result.body, "_shards.failed")) > 0 ||
      !Array.isArray(failures) ||
      failures.length
    )
      throw new Error("Insight retention returned incomplete results");
    this.lastCleanup = deleted >= 1000 ? undefined : timestamp;
  }
  private async flush() {
    const next = this.pending!;
    for (let offset = 0; offset < next.changes.length; offset += 500) {
      const body = next.changes
        .slice(offset, offset + 500)
        .flatMap((incident) => [
          { index: { _index: INSIGHTS_INDEX, _id: incident.id } },
          incident,
        ]);
      const result = await this.client.bulk(
        { body, refresh: "wait_for" },
        requestOptions,
      );
      if (record(result.body).errors !== false)
        throw new Error("Insight write rejected");
    }
    next.commit();
    this.pending = undefined;
  }
}
function clusterIdentity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value === "_na_")
    throw new Error("Cluster identity unavailable");
  return value;
}
async function searchInsights(
  client: OpenSearchClient,
  filter: object[],
  size: number,
) {
  const result = await client.transport.request(
    {
      method: "POST",
      path: `/${INSIGHTS_INDEX}/_search`,
      body: {
        size,
        track_total_hits: true,
        sort: [{ status: "asc" }, { last_seen: "desc" }],
        query: { bool: { filter } },
      },
    },
    requestOptions,
  );
  if (
    at(result.body, "timed_out") === true ||
    Number(at(result.body, "_shards.failed")) > 0
  )
    throw new Error("Insight search returned incomplete results");
  const hits = at(result.body, "hits.hits") as Array<{ _source: Insight }>;
  const total = at(result.body, "hits.total.value");
  if (!Array.isArray(hits) || typeof total !== "number")
    throw new Error("Invalid insight search response");
  return { incidents: hits.map((hit) => hit._source), total };
}
export async function readInsights(
  client: OpenSearchClient,
  query: { from: string; to: string },
) {
  const range = parseRange(query.from, query.to);
  await client.transport.request(
    { method: "GET", path: "/_cluster/health" },
    requestOptions,
  );
  const info = await client.transport.request(
    { method: "GET", path: "/" },
    requestOptions,
  );
  const cluster = clusterIdentity(at(info.body, "cluster_uuid"));
  return {
    ...(await searchInsights(
      client,
      [
        { term: { cluster_uuid: cluster } },
        { range: { detected_at: { lte: range.to } } },
        {
          bool: {
            minimum_should_match: 1,
            should: [
              { term: { status: "active" } },
              { range: { resolved_at: { gte: range.from } } },
            ],
          },
        },
      ],
      500,
    )),
    range,
  };
}
