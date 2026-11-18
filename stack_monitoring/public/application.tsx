import ReactDOM from "react-dom";
import { useEffect, useState } from "react";
import type { CoreStart, AppMountParameters } from "../../../src/core/public";
import {
  EuiPage,
  EuiPageBody,
  EuiTitle,
  EuiText,
  EuiSpacer,
  EuiPanel,
  EuiLink,
  EuiTabs,
  EuiTab,
  EuiSuperDatePicker,
  EuiCallOut,
  EuiLoadingSpinner,
  EuiEmptyPrompt,
  EuiButton,
  EuiSwitch,
  EuiBadge,
  EuiBasicTable,
  EuiIcon,
} from "@elastic/eui";
import type { Entity, MonitoringResponse } from "../common/types";
import { routeFromHash, linkTo } from "../common/navigation";
import { isInternalIndex } from "../common/metrics";
import {
  ChartGrid,
  format,
  ChartSpec,
  searchCharts,
  nodeCharts,
  advancedCharts,
  instanceCharts,
} from "./components/charts";
import {
  EntityTable,
  Health,
  MetricColumn,
  ShardTable,
  RecoveryTable,
} from "./components/tables";
import "./index.scss";
import { Insights } from "./components/insights";
import { CollectionControl } from "./components/collection";
import { usePollingEffect } from "./use_polling_effect";

const names: Record<string, string> = {
  clusters: "Clusters",
  overview: "Cluster overview",
  insights: "Insights",
  opensearch: "OpenSearch overview",
  nodes: "Nodes",
  indices: "Indices",
  pipelines: "Ingest pipelines",
  processors: "Processors",
  dashboards: "Dashboards overview",
  instances: "Instances",
};
const nodeColumns: MetricColumn[] = [
  { key: "shards", name: "Shards" },
  { key: "cpu_percent", name: "CPU", unit: "percent" },
  { key: "heap_percent", name: "JVM heap", unit: "percent" },
  { key: "disk_available", name: "Disk available", unit: "bytes" },
  { key: "load1", name: "Load (1m)" },
];
const indexColumns: MetricColumn[] = [
  { key: "docs", name: "Documents" },
  { key: "store", name: "Total storage", unit: "bytes" },
  { key: "index_primary_rate", name: "Indexing /s", unit: "rate" },
  { key: "search_rate", name: "Search /s", unit: "rate" },
  { key: "unassigned", name: "Unassigned shards" },
];
const pipelineColumns: MetricColumn[] = [
  { key: "ingest_rate", name: "Throughput", unit: "rate" },
  { key: "ingest_latency", name: "Latency", unit: "ms" },
  { key: "failed_rate", name: "Failures", unit: "rate" },
  { key: "current", name: "In progress" },
];
const instanceColumns: MetricColumn[] = [
  { key: "requests", name: "Requests / sample" },
  { key: "response_max", name: "Max response", unit: "ms" },
  { key: "connections", name: "Connections" },
  { key: "heap_used", name: "Used heap", unit: "bytes" },
  { key: "uptime_ms", name: "Uptime", unit: "duration" },
];
const pipelineCharts: ChartSpec[] = [
  {
    title: "Ingest throughput",
    keys: [["ingest_rate", "Documents"]],
    unit: "rate",
  },
  {
    title: "Ingest latency",
    keys: [["ingest_latency", "Processing time"]],
    unit: "ms",
  },
  {
    title: "Ingest failures",
    keys: [["failed_rate", "Failed documents"]],
    unit: "rate",
  },
  { title: "In progress", keys: [["current", "Documents"]] },
];
const indexCharts: ChartSpec[] = [
  ...searchCharts,
  {
    title: "Index size",
    keys: [
      ["store_primary", "Primary shards"],
      ["store", "Total shards"],
    ],
    unit: "bytes",
  },
  { title: "Documents", keys: [["docs", "Primary documents"]] },
  {
    title: "Segments",
    keys: [
      ["segments_primary", "Primary shards"],
      ["segments", "Total shards"],
    ],
  },
];
const indexAdvanced: ChartSpec[] = [
  ...advancedCharts.slice(2, 4),
  {
    title: "Merge, refresh and flush rate",
    keys: [
      ["merge_rate", "Merge"],
      ["refresh_rate", "Refresh"],
      ["flush_rate", "Flush"],
    ],
    unit: "rate",
  },
  {
    title: "Merge, refresh and flush time",
    keys: [
      ["merge_time_rate", "Merge"],
      ["refresh_time_rate", "Refresh"],
      ["flush_time_rate", "Flush"],
    ],
    description: "Milliseconds spent per second; operations may overlap.",
  },
  advancedCharts[7],
];

function SummaryCard({
  title,
  href,
  rows,
  children,
  count,
}: {
  title: string;
  count?: number | null;
  href?: string;
  rows?: Array<[string, React.ReactNode]>;
  children?: React.ReactNode;
}) {
  return (
    <EuiPanel className="sm-card" paddingSize="m">
      <div className="sm-card-heading">
        <EuiTitle size="s">
          <h3>{href ? <EuiLink href={href}>{title}</EuiLink> : title}</h3>
        </EuiTitle>
        {count !== undefined && (
          <span className="sm-card-count">{format(count)}</span>
        )}
      </div>
      <div className="sm-card-rule" />
      {rows && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </EuiPanel>
  );
}
function Logs({
  core,
  from,
  to,
  tick,
}: {
  core: CoreStart;
  from: string;
  to: string;
  tick: number;
}) {
  const [logs, setLogs] = useState<{
    configured: boolean;
    entries: Array<{ _id: string; _source: Record<string, unknown> }>;
  } | null>(null);
  const [error, setError] = useState("");
  usePollingEffect(
    (isCurrent) => {
      return core.http
        .get("/api/stack_monitoring/logs", { query: { from, to } })
        .then((v) => {
          if (isCurrent()) {
            setLogs(v);
            setError("");
          }
        })
        .catch((e) => {
          if (isCurrent())
            setError(e.body?.message || "Cluster logs could not be loaded.");
        });
    },
    [core, from, to],
    tick,
  );
  if (error) return <EuiCallOut color="warning" title={error} />;
  if (!logs) return <EuiLoadingSpinner />;
  if (!logs.configured)
    return (
      <EuiCallOut
        color="warning"
        title="No log data found"
        iconType="iInCircle"
      >
        <p>
          Set <code>stackMonitoring.logs.index</code> to an existing log index
          to show recent cluster logs.
        </p>
      </EuiCallOut>
    );
  if (!logs.entries.length)
    return (
      <EuiText size="s">
        <p>No cluster logs in this time range.</p>
      </EuiText>
    );
  return (
    <EuiBasicTable
      tableCaption="Recent cluster logs"
      items={logs.entries.map((v) => ({ id: v._id, ...v._source }))}
      columns={[
        { field: "@timestamp", name: "Time" },
        {
          field: "message",
          name: "Message",
          render: (v: unknown) => String(v ?? "—"),
        },
      ]}
    />
  );
}
function App({ core, alerting }: { core: CoreStart; alerting: boolean }) {
  const [route, setRoute] = useState(() => routeFromHash(window.location.hash));
  const [data, setData] = useState<MonitoringResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [collectionVersion, setCollectionVersion] = useState(0);
  const [completed, setCompleted] = useState(false);
  const { view, id, advanced, params } = route;
  const from = params.get("from") || "now-15m",
    to = params.get("to") || "now";
  const paused = params.get("paused") === "true";
  const refresh = Math.max(
    10000,
    Math.min(3600000, Number(params.get("refresh")) || 10000),
  );
  const dark = Boolean(core.uiSettings.get("theme:darkMode"));
  const href = (path: string) => linkTo(path, params);
  const update = (values: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) p.set(k, v);
    window.location.hash = linkTo(
      `/${view}${id ? "/" + encodeURIComponent(id) : ""}${advanced ? "/advanced" : ""}`,
      p,
    );
  };
  useEffect(() => {
    const listener = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view, id, advanced]);
  useEffect(() => setData(null), [from, to, route.type, id]);
  usePollingEffect(
    (isCurrent) => {
      setLoading(true);
      setError("");
      return core.http
        .get<MonitoringResponse>("/api/stack_monitoring/history", {
          query: { from, to, type: route.type, id: id || "cluster" },
        })
        .then((v) => {
          if (isCurrent()) setData(v);
        })
        .catch((e) => {
          if (isCurrent())
            setError(
              e.body?.message ||
                e.message ||
                "Monitoring data could not be loaded.",
            );
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [core, from, to, route.type, id, collectionVersion],
    tick,
  );
  const s = data?.snapshot;
  const c = s?.cluster;
  const m = c?.metrics;
  const instance = s?.instances[0];
  const entity = id
    ? (view === "nodes"
        ? s?.nodes
        : view === "indices"
          ? s?.indices
          : view === "instances"
            ? s?.instances
            : view === "processors"
              ? s?.pipelines.flatMap((p) => p.processors || [])
              : [
                  ...(s?.pipelines || []),
                  ...(s?.pipelines.flatMap((p) => p.processors || []) || []),
                ]
      )?.find((e) => e.id === id)
    : undefined;
  const title = id ? entity?.name || id : names[view];
  useEffect(() => {
    if (view === "pipelines" && entity?.type === "processor")
      window.location.hash = href("/processors/" + encodeURIComponent(id));
  }, [view, id, entity?.type]);
  useEffect(() => {
    core.chrome.setBreadcrumbs([
      {
        text: "Stack Monitoring",
        href: core.http.basePath.prepend(
          "/app/stackMonitoring" + href("/clusters"),
        ),
      },
      ...(s ? [{ text: s.cluster_name, href: href("/overview") }] : []),
      { text: title },
    ]);
  }, [core, title, s?.cluster_name, from, to]);
  const points = data?.series || [],
    range = data?.range || { from: Date.now() - 900000, to: Date.now() };
  const charts = (specs: ChartSpec[]) => (
    <ChartGrid specs={specs} points={points} range={range} dark={dark} />
  );
  const table = (
    items: Entity[],
    columns: MetricColumn[],
    path: string,
    caption: string,
  ) => (
    <EntityTable
      items={items}
      columns={columns}
      href={(e) => href(`${path}/${encodeURIComponent(e.id)}`)}
      query={params.get(view + "_q") || ""}
      onQuery={(q) => update({ [view + "_q"]: q })}
      caption={caption}
    />
  );
  const logs = () => <Logs core={core} from={from} to={to} tick={tick} />;
  const dashCards = () => (
    <div className="sm-cards sm-cards-two">
      <SummaryCard
        title="HTTP traffic"
        href={href("/dashboards")}
        rows={[
          ["Requests per sample", format(instance?.metrics.requests)],
          ["Max. response time", format(instance?.metrics.response_max, "ms")],
        ]}
      />
      <SummaryCard
        title="Instances"
        count={s?.instances.length || 0}
        href={href("/instances")}
        rows={[
          ["Connections", format(instance?.metrics.connections)],
          ["Used heap", format(instance?.metrics.heap_used, "bytes")],
          [
            "Heap utilization",
            format(instance?.metrics.heap_percent, "percent"),
          ],
        ]}
      />
    </div>
  );
  const warnings = s
    ? [
        ...(s.cluster.status !== "green"
          ? [`Cluster health is ${s.cluster.status}.`]
          : []),
        ...s.nodes
          .filter((n) => (n.metrics.heap_percent ?? 0) > 85)
          .map((n) => `${n.name}: JVM heap exceeds 85%.`),
        ...s.nodes
          .filter((n) => (n.metrics.disk_percent ?? 100) < 15)
          .map((n) => `${n.name}: less than 15% disk space available.`),
      ]
    : [];
  return (
    <EuiPage className={`sm-app${dark ? " sm-app--dark" : ""}`}>
      <EuiPageBody>
        <div className="sm-heading">
          <div>
            <EuiTitle size="l">
              <h1>{title}</h1>
            </EuiTitle>
          </div>
          <div className="sm-toolbar">
            <CollectionControl
              core={core}
              tick={tick}
              onChange={(collection) => {
                setData((value) => (value ? { ...value, collection } : value));
                setCollectionVersion((v) => v + 1);
                setTick((v) => v + 1);
              }}
            />
            <div className="sm-time-controls">
              <EuiSuperDatePicker
                start={from}
                end={to}
                isPaused={paused}
                refreshInterval={refresh}
                isLoading={loading}
                onTimeChange={({ start, end, isInvalid }) => {
                  if (!isInvalid) update({ from: start, to: end });
                }}
                onRefresh={() => setTick((v) => v + 1)}
                onRefreshChange={({ isPaused, refreshInterval }) =>
                  update({
                    paused: String(isPaused),
                    refresh: String(Math.max(10000, refreshInterval)),
                  })
                }
                commonlyUsedRanges={[
                  { start: "now-15m", end: "now", label: "Last 15 minutes" },
                  { start: "now-1h", end: "now", label: "Last hour" },
                  { start: "now-6h", end: "now", label: "Last 6 hours" },
                  { start: "now-24h", end: "now", label: "Last 24 hours" },
                ]}
              />
            </div>
          </div>
        </div>
        <EuiSpacer size="m" />
        <EuiTabs>
          {[
            "overview",
            "insights",
            "opensearch",
            "nodes",
            "indices",
            "pipelines",
            "dashboards",
            "instances",
          ].map((v) => (
            <EuiTab
              key={v}
              href={href("/" + v)}
              isSelected={
                view === v || (view === "processors" && v === "pipelines")
              }
            >
              {v === "overview"
                ? "Cluster"
                : v === "opensearch"
                  ? "OpenSearch"
                  : v === "dashboards"
                    ? "Dashboards"
                    : names[v]}
            </EuiTab>
          ))}
        </EuiTabs>
        <EuiSpacer size="m" />
        {view === "insights" ? (
          <Insights
            core={core}
            from={from}
            to={to}
            tick={tick}
            dark={dark}
            collectionVersion={collectionVersion}
          />
        ) : error ? (
          <EuiCallOut
            color="danger"
            title="Unable to load monitoring data"
            iconType="alert"
          >
            <p>{error}</p>
            <EuiButton size="s" onClick={() => setTick((v) => v + 1)}>
              Retry
            </EuiButton>
          </EuiCallOut>
        ) : loading && !data ? (
          <div className="sm-loading">
            <EuiLoadingSpinner size="xl" />
            <EuiText>
              <p>Loading monitoring samples…</p>
            </EuiText>
          </div>
        ) : !s ? (
          <EuiEmptyPrompt
            iconType="monitoringApp"
            title={<h2>No monitoring data found</h2>}
            body={
              <>
                <p>
                  No samples exist in the selected time range. Try the last 15
                  minutes and refresh.
                </p>
                <p>
                  {data?.collection.enabled
                    ? "The collector samples every 10 seconds."
                    : "Self-monitoring is disabled. Use the Self-monitoring control above to enable collection."}
                </p>
                {data?.collection.last_error && (
                  <p>{data.collection.last_error}</p>
                )}
              </>
            }
            actions={
              <EuiButton
                onClick={() => {
                  update({ from: "now-15m", to: "now" });
                  setTick((v) => v + 1);
                }}
              >
                Refresh recent data
              </EuiButton>
            }
          />
        ) : (
          <>
            <div className="sm-status">
              <Health status={c!.status} />
              <strong>{s.cluster_name}</strong>
              <span>
                Nodes <b>{format(m!.nodes)}</b>
              </span>
              <span>
                User indices <b>{format(m!.indices)}</b>
              </span>
              <span>
                Primary shards <b>{format(m!.primary_shards)}</b>
              </span>
              <span>
                Unassigned <b>{format(m!.unassigned)}</b>
              </span>
              <span className="sm-sample">
                Sample: {new Date(s.timestamp).toLocaleString()}
              </span>
              {alerting && (
                <EuiLink
                  className="sm-alert-link"
                  href={core.http.basePath.prepend("/app/alerting")}
                >
                  Alerts and rules
                </EuiLink>
              )}
            </div>
            {data?.collection.enabled &&
              to === "now" &&
              Date.now() - s.timestamp > 30000 && (
                <>
                  <EuiCallOut
                    title="Monitoring samples are stale"
                    color="warning"
                  >
                    <p>
                      Last sample was{" "}
                      {format(Date.now() - s.timestamp, "duration")} ago. Check
                      collection and cluster connectivity.
                    </p>
                  </EuiCallOut>
                  <EuiSpacer size="m" />
                </>
              )}
            {data && !data.collection.enabled && (
              <>
                <EuiCallOut title="Self-monitoring is disabled" color="warning">
                  <p>
                    Existing history remains available. Enable self-monitoring
                    above to collect new samples.
                  </p>
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            )}
            {(s.errors.length > 0 || data?.collection.last_error) && (
              <>
                <EuiCallOut
                  title="Some monitoring data is unavailable"
                  color="warning"
                >
                  <p>{s.errors.join(" ") || data?.collection.last_error}</p>
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            )}
            {warnings.length > 0 && (
              <div className="sm-alerts">
                {warnings.map((w) => (
                  <EuiBadge key={w} color="warning">
                    {w}
                  </EuiBadge>
                ))}
              </div>
            )}
            {id && !entity && !points.length ? (
              <EuiEmptyPrompt
                title={<h2>Entity not found</h2>}
                body={<p>This entity has no sample in the selected range.</p>}
                actions={
                  <EuiButton
                    href={href(
                      view === "processors" ? "/pipelines" : "/" + view,
                    )}
                  >
                    Back to {names[view]}
                  </EuiButton>
                }
              />
            ) : id && (entity || points.length > 0) ? (
              <>
                {!entity && (
                  <EuiCallOut
                    color="warning"
                    title="Entity is absent from the latest sample"
                  >
                    <p>
                      Historical metrics remain available for the selected
                      range.
                    </p>
                  </EuiCallOut>
                )}
                {entity && (
                  <div className="sm-detail-meta">
                    <Health status={entity.status} />
                    {entity.address && <span>{entity.address}</span>}
                    {entity.version && <span>Version {entity.version}</span>}
                    {entity.roles?.map((role) => (
                      <EuiBadge color="hollow" key={role}>
                        {role}
                      </EuiBadge>
                    ))}
                    {entity.metrics.uptime_ms != null && (
                      <span>
                        Uptime {format(entity.metrics.uptime_ms, "duration")}
                      </span>
                    )}
                  </div>
                )}
                {(view === "nodes" || view === "indices") && (
                  <>
                    <EuiTabs>
                      <EuiTab
                        href={href(`/${view}/${encodeURIComponent(id)}`)}
                        isSelected={!advanced}
                      >
                        Overview
                      </EuiTab>
                      <EuiTab
                        href={href(
                          `/${view}/${encodeURIComponent(id)}/advanced`,
                        )}
                        isSelected={advanced}
                      >
                        Advanced
                      </EuiTab>
                    </EuiTabs>
                    <EuiSpacer size="m" />
                  </>
                )}
                {charts(
                  view === "nodes"
                    ? advanced
                      ? advancedCharts
                      : nodeCharts
                    : view === "indices"
                      ? advanced
                        ? indexAdvanced
                        : indexCharts
                      : view === "pipelines" || view === "processors"
                        ? pipelineCharts
                        : instanceCharts,
                )}
                {view === "pipelines" && entity?.processors && (
                  <>
                    <EuiSpacer />
                    <EuiTitle size="s">
                      <h2>Processors</h2>
                    </EuiTitle>
                    <EuiSpacer size="m" />
                    {table(
                      entity.processors,
                      pipelineColumns,
                      "/processors",
                      "Processors",
                    )}
                  </>
                )}
                {entity && (view === "nodes" || view === "indices") && (
                  <>
                    <EuiSpacer />
                    <EuiPanel>
                      <EuiTitle size="s">
                        <h2>Shard allocation</h2>
                      </EuiTitle>
                      <EuiSpacer size="m" />
                      <ShardTable
                        shards={s.shards.filter((sh) =>
                          view === "nodes"
                            ? sh.node === entity.name
                            : sh.index === entity.name,
                        )}
                        href={href}
                      />
                    </EuiPanel>
                    <EuiSpacer />
                    <SummaryCard title="Recent cluster logs">
                      {logs()}
                    </SummaryCard>
                  </>
                )}
              </>
            ) : (
              <>
                {view === "clusters" &&
                  table(
                    [{ ...c!, id: "overview" }],
                    [
                      { key: "nodes", name: "Nodes" },
                      { key: "indices", name: "User indices" },
                      { key: "docs", name: "Documents" },
                      {
                        key: "heap_percent",
                        name: "JVM heap",
                        unit: "percent",
                      },
                    ],
                    "",
                    "Clusters",
                  )}
                {view === "overview" && (
                  <>
                    <EuiTitle size="m">
                      <h2 className="sm-section-title">
                        <EuiIcon
                          type="database"
                          className="sm-section-icon"
                          aria-hidden="true"
                        />
                        <EuiLink href={href("/opensearch")}>OpenSearch</EuiLink>
                      </h2>
                    </EuiTitle>
                    <EuiSpacer size="m" />
                    <div className="sm-cards">
                      <SummaryCard
                        title="Cluster health"
                        href={href("/opensearch")}
                        rows={[
                          ["Health", <Health status={c!.status} />],
                          ["Version", c!.version],
                          [
                            "Uptime (shortest node)",
                            format(m!.uptime_ms, "duration"),
                          ],
                        ]}
                      />
                      <SummaryCard
                        title="Nodes"
                        count={m!.nodes}
                        href={href("/nodes")}
                        rows={[
                          [
                            "Disk available",
                            <>
                              {format(m!.disk_percent, "percent")}
                              <div className="sm-metric-detail">
                                {format(m!.disk_available, "bytes")} /{" "}
                                {format(m!.disk_total, "bytes")}
                              </div>
                            </>,
                          ],
                          [
                            "JVM heap",
                            <>
                              {format(m!.heap_percent, "percent")}
                              <div className="sm-metric-detail">
                                {format(m!.heap_used, "bytes")} /{" "}
                                {format(m!.heap_max, "bytes")}
                              </div>
                            </>,
                          ],
                        ]}
                      />
                      <SummaryCard
                        title="User indices"
                        count={m!.indices}
                        href={href("/indices")}
                        rows={[
                          ["Documents", format(m!.docs)],
                          ["Disk usage", format(m!.store, "bytes")],
                          ["Primary shards", format(m!.user_primary_shards)],
                          ["Replica shards", format(m!.user_replica_shards)],
                        ]}
                      />
                      <SummaryCard title="Logs">{logs()}</SummaryCard>
                    </div>
                    <EuiSpacer size="s" />
                    <EuiText size="xs" color="subdued">
                      <p>
                        Disk capacity is summed across nodes; containers may
                        share the same physical disk. User totals exclude
                        internal indices.
                      </p>
                    </EuiText>
                    <EuiSpacer size="l" />
                    <EuiTitle size="m">
                      <h2 className="sm-section-title">
                        <EuiIcon
                          type="dashboardApp"
                          className="sm-section-icon"
                          aria-hidden="true"
                        />
                        <EuiLink href={href("/dashboards")}>
                          OpenSearch Dashboards
                        </EuiLink>
                      </h2>
                    </EuiTitle>
                    <EuiSpacer size="m" />
                    {dashCards()}
                  </>
                )}
                {view === "nodes" &&
                  table(s.nodes, nodeColumns, "/nodes", "Nodes")}
                {view === "indices" && (
                  <>
                    <EuiSwitch
                      label="Show system and monitoring indices"
                      checked={params.get("system") === "true"}
                      onChange={(e) =>
                        update({ system: String(e.target.checked) })
                      }
                    />
                    <EuiSpacer size="m" />
                    {table(
                      s.indices.filter(
                        (e) =>
                          params.get("system") === "true" ||
                          !isInternalIndex(e.name),
                      ),
                      indexColumns,
                      "/indices",
                      "Indices",
                    )}
                  </>
                )}
                {view === "pipelines" &&
                  (s.pipelines.length ? (
                    table(
                      s.pipelines,
                      pipelineColumns,
                      "/pipelines",
                      "Ingest pipelines",
                    )
                  ) : (
                    <EuiEmptyPrompt
                      title={<h2>No ingest pipeline activity</h2>}
                      body={
                        <p>
                          Pipeline statistics appear after a pipeline processes
                          documents.
                        </p>
                      }
                    />
                  ))}
                {view === "instances" &&
                  table(
                    s.instances,
                    instanceColumns,
                    "/instances",
                    "Dashboards instances",
                  )}
                {view === "dashboards" && (
                  <>
                    {dashCards()}
                    <EuiSpacer />
                    {instance ? (
                      <EuiButton
                        href={href(
                          "/instances/" + encodeURIComponent(instance.id),
                        )}
                      >
                        View instance metrics
                      </EuiButton>
                    ) : (
                      <EuiText>
                        <p>No Dashboards process metrics have arrived yet.</p>
                      </EuiText>
                    )}
                  </>
                )}
                {view === "opensearch" && (
                  <>
                    {charts([
                      ...searchCharts,
                      {
                        title: "Unassigned shards",
                        keys: [["unassigned", "Unassigned shards"]],
                      },
                    ])}
                    <EuiSpacer />
                    <SummaryCard title="Recent cluster logs">
                      {logs()}
                    </SummaryCard>
                    <EuiSpacer />
                    <EuiPanel>
                      <div className="sm-chart-title">
                        <EuiTitle size="s">
                          <h2>Shard recovery</h2>
                        </EuiTitle>
                        <EuiSwitch
                          label="Show completed recoveries"
                          checked={completed}
                          onChange={(e) => setCompleted(e.target.checked)}
                        />
                      </div>
                      <EuiSpacer size="m" />
                      <RecoveryTable
                        items={s.recoveries.filter(
                          (r) => completed || r.stage !== "done",
                        )}
                      />
                    </EuiPanel>
                  </>
                )}
              </>
            )}
          </>
        )}
      </EuiPageBody>
    </EuiPage>
  );
}
export function renderApp(
  core: CoreStart,
  params: AppMountParameters,
  alerting: boolean,
) {
  ReactDOM.render(<App core={core} alerting={alerting} />, params.element);
  return () => ReactDOM.unmountComponentAtNode(params.element);
}
