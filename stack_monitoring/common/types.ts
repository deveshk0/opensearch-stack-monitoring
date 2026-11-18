export type MetricMap = Record<string, number | null>;
export type EntityType =
  "cluster" | "node" | "index" | "pipeline" | "processor" | "instance";
export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  status: string;
  metrics: MetricMap;
  counters: MetricMap;
  address?: string;
  version?: string;
  roles?: string[];
  generation?: string;
  processors?: Entity[];
}
export interface Shard {
  index: string;
  shard: string;
  primary: boolean;
  state: string;
  node: string;
}
export interface Recovery {
  index: string;
  shard: string;
  stage: string;
  source: string;
  target: string;
  time: string;
  files: string;
  bytes: string;
}
export interface Snapshot {
  schema: 1;
  timestamp: number;
  cluster_uuid: string;
  cluster_name: string;
  cluster: Entity;
  nodes: Entity[];
  indices: Entity[];
  pipelines: Entity[];
  instances: Entity[];
  shards: Shard[];
  recoveries: Recovery[];
  errors: string[];
  source_validity?: Record<
    "nodeStats" | "indexStats" | "health" | "shards",
    boolean
  >;
}
export interface Point {
  timestamp: number;
  metrics: MetricMap;
}
export interface MonitoringResponse {
  snapshot: Snapshot | null;
  series: Point[];
  range: { from: number; to: number; interval: number };
  collection: {
    enabled: boolean;
    last_success: number | null;
    last_error: string | null;
    collecting: boolean;
    insights_error?: string | null;
  };
}
export interface RawSnapshot {
  timestamp: number;
  info: unknown;
  health: unknown;
  cluster: unknown;
  nodeStats: unknown;
  nodeInfo: unknown;
  indexStats: unknown;
  shards: unknown;
  recovery: unknown;
  dashboards: unknown;
  instance: { id: string; name: string; version: string; address: string };
  errors: string[];
}
