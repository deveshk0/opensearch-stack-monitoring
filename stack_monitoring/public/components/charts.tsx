import { useState } from "react";
import {
  EuiPanel,
  EuiTitle,
  EuiSpacer,
  EuiButtonEmpty,
  EuiBasicTable,
  EuiText,
} from "@elastic/eui";
import {
  Chart,
  Settings,
  LineSeries,
  Axis,
  Position,
  ScaleType,
  LIGHT_THEME,
  DARK_THEME,
} from "@elastic/charts";
import type { Point } from "../../common/types";

export type Unit = "number" | "bytes" | "percent" | "ms" | "rate" | "duration";
export function format(
  value: number | null | undefined,
  unit: Unit = "number",
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i =
      value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
    return `${(value / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
  }
  if (unit === "duration") {
    if (value < 60000) return `${Math.floor(value / 1000)} s`;
    if (value < 3600000) return `${Math.floor(value / 60000)} min`;
    return `${(value / 3600000).toFixed(1)} h`;
  }
  const suffix =
    unit === "percent"
      ? "%"
      : unit === "ms"
        ? " ms"
        : unit === "rate"
          ? " /s"
          : "";
  return (
    value.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    }) + suffix
  );
}
export interface ChartSpec {
  title: string;
  keys: Array<[string, string]>;
  unit?: Unit;
  description?: string;
}
export function MetricChart({
  spec,
  points,
  range,
  dark,
}: {
  spec: ChartSpec;
  points: Point[];
  range: { from: number; to: number };
  dark: boolean;
}) {
  const [table, setTable] = useState(false);
  const hasData = points.some((p) =>
    spec.keys.some(
      ([key]) => p.metrics[key] !== null && p.metrics[key] !== undefined,
    ),
  );
  const rows = points.map((p) => ({ timestamp: p.timestamp, ...p.metrics }));
  return (
    <EuiPanel className="sm-chart" paddingSize="m">
      <div className="sm-chart-title">
        <EuiTitle size="xs">
          <h3>{spec.title}</h3>
        </EuiTitle>
        <EuiButtonEmpty
          size="xs"
          onClick={() => setTable(!table)}
          aria-label={`${table ? "Hide" : "View"} data for ${spec.title}`}
        >
          {table ? "Chart" : "View data"}
        </EuiButtonEmpty>
      </div>
      {spec.description && (
        <EuiText size="xs" color="subdued">
          <p>{spec.description}</p>
        </EuiText>
      )}
      <EuiSpacer size="s" />
      {!hasData ? (
        <div className="sm-chart-empty">
          No samples for this metric in the selected time range.
        </div>
      ) : table ? (
        <div className="sm-chart-data">
          <EuiBasicTable<Record<string, number | null>>
            items={rows}
            tableCaption={spec.title}
            columns={[
              {
                field: "timestamp",
                name: "Time",
                render: (v: number) => new Date(v).toLocaleString(),
              },
              ...spec.keys.map(([key, label]) => ({
                field: key,
                name: label,
                render: (v: number | null) => format(v, spec.unit),
              })),
            ]}
          />
        </div>
      ) : (
        <div
          className="sm-chart-canvas"
          role="img"
          aria-label={`${spec.title}. Use View data for an accessible table.`}
        >
          <Chart>
            <Settings
              baseTheme={dark ? DARK_THEME : LIGHT_THEME}
              showLegend
              legendPosition={Position.Bottom}
              xDomain={{ min: range.from, max: range.to }}
            />
            <Axis
              id="time"
              position={Position.Bottom}
              tickFormat={(v) =>
                new Date(Number(v)).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              }
            />
            <Axis
              id="value"
              position={Position.Left}
              tickFormat={(v) => format(Number(v), spec.unit)}
            />
            {spec.keys.map(([key, label], i) => (
              <LineSeries
                key={key}
                id={label}
                xScaleType={ScaleType.Time}
                yScaleType={ScaleType.Linear}
                xAccessor="timestamp"
                yAccessors={[key]}
                data={points.map((p) => ({
                  timestamp: p.timestamp,
                  [key]: p.metrics[key] ?? null,
                }))}
                color={["#2FAFA0", "#3877B5", "#9170B8", "#D36086"][i % 4]}
              />
            ))}
          </Chart>
        </div>
      )}
    </EuiPanel>
  );
}
export function ChartGrid({
  specs,
  points,
  range,
  dark,
}: {
  specs: ChartSpec[];
  points: Point[];
  range: { from: number; to: number };
  dark: boolean;
}) {
  return (
    <div className="sm-chart-grid">
      {specs.map((spec) => (
        <MetricChart
          key={spec.title}
          spec={spec}
          points={points}
          range={range}
          dark={dark}
        />
      ))}
    </div>
  );
}
export const searchCharts: ChartSpec[] = [
  {
    title: "Search rate",
    keys: [["search_rate", "Total shards"]],
    unit: "rate",
    description: "Shard-level search operations per second.",
  },
  {
    title: "Search latency",
    keys: [["search_latency", "Search"]],
    unit: "ms",
    description: "Time spent searching divided by completed searches.",
  },
  {
    title: "Indexing rate",
    keys: [
      ["index_rate", "Total shards"],
      ["index_primary_rate", "Primary shards"],
    ],
    unit: "rate",
  },
  {
    title: "Indexing latency",
    keys: [["index_primary_latency", "Primary shards"]],
    unit: "ms",
  },
];
export const nodeCharts: ChartSpec[] = [
  {
    title: "JVM heap",
    keys: [
      ["heap_used", "Used heap"],
      ["heap_max", "Maximum heap"],
    ],
    unit: "bytes",
  },
  {
    title: "Disk available",
    keys: [["disk_percent", "Available capacity"]],
    unit: "percent",
  },
  {
    title: "I/O operations",
    keys: [
      ["io_read_rate", "Read"],
      ["io_write_rate", "Write"],
    ],
    unit: "rate",
  },
  {
    title: "CPU utilization",
    keys: [["cpu_percent", "Process CPU"]],
    unit: "percent",
  },
  {
    title: "System load",
    keys: [
      ["load1", "1 minute"],
      ["load5", "5 minutes"],
      ["load15", "15 minutes"],
    ],
  },
  {
    title: "Latency",
    keys: [
      ["search_latency", "Search"],
      ["index_latency", "Indexing"],
    ],
    unit: "ms",
  },
  { title: "Segment count", keys: [["segments", "Segments"]] },
];
export const advancedCharts: ChartSpec[] = [
  {
    title: "Garbage collection rate",
    keys: [
      ["gc_young_rate", "Young"],
      ["gc_old_rate", "Old"],
    ],
    unit: "rate",
  },
  {
    title: "Garbage collection duration",
    keys: [
      ["gc_young_latency", "Young"],
      ["gc_old_latency", "Old"],
    ],
    unit: "ms",
  },
  {
    title: "Index memory",
    keys: [
      ["index_writer", "Index writer"],
      ["version_map", "Version map"],
      ["fixed_bitsets", "Fixed bitsets"],
    ],
    unit: "bytes",
  },
  {
    title: "Caches",
    keys: [
      ["query_cache", "Query cache"],
      ["request_cache", "Request cache"],
      ["fielddata", "Fielddata"],
    ],
    unit: "bytes",
  },
  {
    title: "Write queue and rejections",
    keys: [
      ["write_queue", "Queued"],
      ["write_rejected_rate", "Rejected /s"],
    ],
  },
  {
    title: "Search queue and rejections",
    keys: [
      ["search_queue", "Queued"],
      ["search_rejected_rate", "Rejected /s"],
    ],
  },
  {
    title: "GET queue and rejections",
    keys: [
      ["get_queue", "Queued"],
      ["get_rejected_rate", "Rejected /s"],
    ],
  },
  {
    title: "Index throttling",
    keys: [["throttle_time_rate", "Milliseconds throttled /s"]],
    unit: "number",
  },
];
export const instanceCharts: ChartSpec[] = [
  {
    title: "Client requests",
    keys: [
      ["requests", "Requests per sample"],
      ["disconnects", "Disconnects per sample"],
    ],
  },
  {
    title: "Client response time",
    keys: [
      ["response_avg", "Average"],
      ["response_max", "Maximum"],
    ],
    unit: "ms",
  },
  {
    title: "Memory",
    keys: [
      ["heap_used", "Used heap"],
      ["heap_max", "Heap limit"],
      ["rss", "Resident memory"],
    ],
    unit: "bytes",
  },
  { title: "HTTP connections", keys: [["connections", "Connections"]] },
  {
    title: "System load",
    keys: [
      ["load1", "1 minute"],
      ["load5", "5 minutes"],
      ["load15", "15 minutes"],
    ],
  },
  {
    title: "Event loop delay",
    keys: [["event_loop_delay", "Delay"]],
    unit: "ms",
  },
];
