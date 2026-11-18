import type { EntityType } from "./types";
export const INSIGHTS_INDEX = "stack-monitoring-insights-v1";
export const INSIGHT_WINDOW = 60000;
export interface InsightRule {
  id: string;
  title: string;
  type: EntityType;
  metric: string;
  unit: "percent" | "rate" | "number";
  operator: ">=" | "<=" | ">";
  threshold: number;
  severity: "warning" | "critical";
  impact: string;
  causes: string;
  steps: string[];
  docs: string;
}
const statsDocs =
  "https://docs.opensearch.org/latest/api-reference/nodes-apis/nodes-stats/";
export const INSIGHT_RULES: InsightRule[] = [
  {
    id: "heap-pressure",
    title: "Sustained JVM heap pressure",
    type: "node",
    metric: "heap_percent",
    unit: "percent",
    operator: ">=",
    threshold: 85,
    severity: "warning",
    impact:
      "Sustained heap pressure can increase garbage collection work and delay requests.",
    causes:
      "Expensive queries, indexing load or shard overhead may contribute. Heap usage alone does not identify the cause.",
    steps: [
      "Compare JVM heap and garbage collection charts with search and indexing activity.",
      "Inspect expensive queries and shard distribution on this node.",
      "Review workload and memory sizing after identifying the source of pressure.",
    ],
    docs: statsDocs,
  },
  {
    id: "cpu-pressure",
    title: "Sustained CPU pressure",
    type: "node",
    metric: "cpu_percent",
    unit: "percent",
    operator: ">=",
    threshold: 90,
    severity: "warning",
    impact: "High process CPU can reduce capacity for incoming requests.",
    causes:
      "Search, indexing, merges or garbage collection may be consuming CPU.",
    steps: [
      "Compare CPU with search, indexing, merge and garbage collection activity.",
      "Inspect hot threads and expensive queries to identify the busy work.",
      "Review concurrency and node capacity based on the affected workload.",
    ],
    docs: statsDocs,
  },
  {
    id: "disk-pressure",
    title: "Low available disk space",
    type: "node",
    metric: "disk_percent",
    unit: "percent",
    operator: "<=",
    threshold: 10,
    severity: "critical",
    impact: "Low free space can constrain shard allocation and indexing.",
    causes:
      "Index growth or uneven shard placement may be using the available disk. This heuristic does not read configured disk watermarks.",
    steps: [
      "Check the node filesystem and configured allocation disk watermarks.",
      "Compare index sizes and shard distribution to locate the growth.",
      "Review retention and storage capacity; validate data retention requirements before deleting anything.",
    ],
    docs: "https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/cluster-settings/",
  },
  ...(["search", "write"] as const).flatMap((pool): InsightRule[] => [
    {
      id: `${pool}-queue`,
      title: `Sustained ${pool} queue`,
      type: "node",
      metric: `${pool}_queue`,
      unit: "number",
      operator: ">=",
      threshold: 100,
      severity: "warning",
      impact: `Queued ${pool} work can increase request waiting time.`,
      causes:
        "Incoming concurrency may exceed processing capacity, or a resource bottleneck may be slowing work.",
      steps: [
        `Compare the ${pool} queue with CPU, heap and rejection charts.`,
        "Identify slow or expensive work and review client concurrency.",
        "Address the bottleneck before increasing thread pool queue limits.",
      ],
      docs: statsDocs,
    },
    {
      id: `${pool}-rejections`,
      title: `Sustained ${pool} rejections`,
      type: "node",
      metric: `${pool}_rejected_rate`,
      unit: "rate",
      operator: ">",
      threshold: 0,
      severity: "critical",
      impact: `The ${pool} thread pool is rejecting requests.`,
      causes:
        "The thread pool may be saturated; request errors and queue metrics provide additional evidence.",
      steps: [
        `Inspect ${pool} queue depth and client response errors.`,
        "Review client concurrency, bounded retries and backoff.",
        "Correlate with CPU, heap and workload charts before changing capacity.",
      ],
      docs: statsDocs,
    },
  ]),
  {
    id: "unassigned-shards",
    title: "Shards remain unassigned",
    type: "cluster",
    metric: "unassigned",
    unit: "number",
    operator: ">",
    threshold: 0,
    severity: "critical",
    impact:
      "Unassigned replicas reduce redundancy; unassigned primaries can make data unavailable.",
    causes:
      "Node availability, disk constraints, allocation filters or replica requirements may prevent allocation.",
    steps: [
      "Inspect shard allocation to distinguish primary and replica shards.",
      "Use the Cluster Allocation Explain API to identify the allocation deciders.",
      "Check node availability, capacity and allocation settings against the explanation.",
    ],
    docs: "https://docs.opensearch.org/latest/api-reference/cluster-api/cluster-allocation/",
  },
  {
    id: "ingest-failures",
    title: "Sustained ingest pipeline failures",
    type: "pipeline",
    metric: "failed_rate",
    unit: "rate",
    operator: ">",
    threshold: 0,
    severity: "warning",
    impact:
      "Failed pipeline executions may prevent documents from being indexed.",
    causes:
      "Input values or processor configuration may be incompatible with the pipeline.",
    steps: [
      "Open the pipeline processor breakdown and inspect indexing error responses.",
      "Use the Simulate Pipeline API with a representative failed document to isolate the processor.",
      "Review processor conditions and failure handling against the intended data contract.",
    ],
    docs: "https://docs.opensearch.org/latest/ingest-pipelines/simulate-ingest/",
  },
];
export interface Insight {
  id: string;
  cluster_uuid: string;
  rule_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: EntityType;
  severity: InsightRule["severity"];
  status: "active" | "resolved";
  first_seen: number;
  detected_at: number;
  last_seen: number;
  last_evaluated: number;
  resolved_at: number | null;
  value: number;
  evidence: Array<{ timestamp: number; value: number | null }>;
}
export interface InsightsResponse {
  incidents: Insight[];
  total: number;
  range: { from: number; to: number };
}
