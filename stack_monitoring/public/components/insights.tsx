import { useEffect, useState } from "react";
import type { CoreStart } from "../../../../src/core/public";
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiEmptyPrompt,
  EuiFieldSearch,
  EuiSelect,
  EuiInMemoryTable,
  EuiText,
  EuiTitle,
  EuiSpacer,
  EuiLoadingSpinner,
  EuiAccordion,
  EuiFlyout,
  EuiFlyoutHeader,
  EuiFlyoutBody,
  EuiLink,
} from "@elastic/eui";
import {
  INSIGHT_RULES,
  Insight,
  InsightsResponse,
} from "../../common/insights";
import type { MonitoringResponse } from "../../common/types";
import { linkTo } from "../../common/navigation";
import { ChartGrid, format } from "./charts";
import { usePollingEffect } from "../use_polling_effect";
const date = (value: number) => new Date(value).toLocaleString();
const stale = (incident: Insight) =>
  incident.status === "active" && Date.now() - incident.last_evaluated > 30000;
type Response = InsightsResponse & {
  collection: MonitoringResponse["collection"];
};
export function Insights({
  core,
  from,
  to,
  tick,
  dark,
  collectionVersion = 0,
}: {
  core: CoreStart;
  from: string;
  to: string;
  tick: number;
  dark: boolean;
  collectionVersion?: number;
}) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setSelectedId(null);
  }, [from, to]);
  usePollingEffect(
    (isCurrent) => {
      setLoading(true);
      return core.http
        .get<Response>("/api/stack_monitoring/insights", {
          query: { from, to },
        })
        .then((value) => {
          if (isCurrent()) {
            setData(value);
            setError("");
          }
        })
        .catch((e) => {
          if (isCurrent())
            setError(e.body?.message || "Recommendations could not be loaded.");
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [core, from, to, collectionVersion],
    tick,
  );
  const items = (data?.incidents || []).filter((incident) => {
    const rule = INSIGHT_RULES.find((r) => r.id === incident.rule_id);
    return (
      (status === "all" || status === incident.status) &&
      `${rule?.title || incident.rule_id} ${incident.entity_name}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });
  const selected = data?.incidents.find((i) => i.id === selectedId);
  const selectedRule = INSIGHT_RULES.find((r) => r.id === selected?.rule_id);
  const current =
    data?.incidents.filter((i) => i.status === "active").length || 0;
  const uncertain = data?.incidents.filter(stale).length || 0;
  const collection = data?.collection;
  const evidenceLink = (incident: Insight) => {
    const path =
      incident.entity_type === "node"
        ? `/nodes/${encodeURIComponent(incident.entity_id)}${["heap-pressure", "cpu-pressure", "disk-pressure"].includes(incident.rule_id) ? "" : "/advanced"}`
        : incident.entity_type === "pipeline"
          ? `/pipelines/${encodeURIComponent(incident.entity_id)}`
          : "/opensearch";
    const end = Math.min(Date.now(), incident.last_seen + 60000);
    return linkTo(
      path,
      new URLSearchParams({
        from: new Date(
          Math.max(incident.first_seen - 60000, end - 86400000),
        ).toISOString(),
        to: new Date(end).toISOString(),
        paused: "true",
      }),
    );
  };
  return (
    <div className="sm-insights">
      <div className="sm-insights-intro">
        <div>
          <EuiTitle size="s">
            <h2>Find the pressure. Understand the next step.</h2>
          </EuiTitle>
          <EuiText size="s" color="subdued">
            <p>
              Nine checks look for sustained resource pressure and failed work.
              Recommendations are advisory; no cluster settings are changed.
            </p>
          </EuiText>
        </div>
        <EuiBadge color="hollow">Recommendations only</EuiBadge>
      </div>
      <EuiSpacer size="m" />
      {error ? (
        <EuiCallOut color="danger" title="Unable to load insights">
          <p>{error}</p>
        </EuiCallOut>
      ) : !data ? (
        <div className="sm-loading">
          <EuiLoadingSpinner size="l" />
          <p>Loading insights…</p>
        </div>
      ) : (
        <>
          {(!collection?.enabled ||
            collection.last_error ||
            collection.insights_error ||
            !collection.last_success ||
            Date.now() - collection.last_success > 30000) && (
            <>
              <EuiCallOut
                color="warning"
                title="Current conditions are not verified"
              >
                <p>
                  {!collection?.enabled
                    ? "Self-monitoring is disabled. Enable it above to evaluate new samples."
                    : collection.insights_error
                      ? "Insight evaluation failed: " +
                        collection.insights_error
                      : "Collection is incomplete or waiting for fresh samples. Existing findings remain available."}{" "}
                  Missing data never resolves a finding.
                </p>
              </EuiCallOut>
              <EuiSpacer size="m" />
            </>
          )}
          <div className="sm-insight-summary">
            <div>
              <span>Open findings</span>
              <strong>{current}</strong>
            </div>
            <div>
              <span>Resolved findings</span>
              <strong>{data.incidents.length - current}</strong>
            </div>
            <div>
              <span>Awaiting fresh evidence</span>
              <strong>{uncertain}</strong>
            </div>
            <div>
              <span>Detection window</span>
              <strong>1 minute</strong>
            </div>
          </div>
          <EuiSpacer size="m" />
          <EuiText size="xs" color="subdued">
            <p>
              Showing incidents overlapping the selected range, with their
              latest known status. Recovery requires one minute of healthy
              samples.{" "}
              {data.total > 500
                ? `Showing the first 500 of ${data.total} matches; counts and filters apply to these 500. Narrow the time range for more detail.`
                : ""}
            </p>
          </EuiText>
          <EuiSpacer size="m" />
          <div className="sm-insight-filters">
            <EuiFieldSearch
              aria-label="Search insights"
              placeholder="Search findings or entities"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <EuiSelect
              aria-label="Finding status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[
                { value: "all", text: "All findings" },
                { value: "active", text: "Open" },
                { value: "resolved", text: "Resolved" },
              ]}
            />
            {loading && <EuiLoadingSpinner />}
          </div>
          <EuiSpacer size="m" />
          {items.length ? (
            <EuiInMemoryTable<Insight>
              tableCaption="Operational findings"
              items={items}
              itemId="id"
              pagination={{
                initialPageSize: 10,
                pageSizeOptions: [10, 25, 50],
              }}
              columns={[
                {
                  field: "rule_id",
                  name: "Finding",
                  render: (_: string, item: Insight) => (
                    <EuiLink onClick={() => setSelectedId(item.id)}>
                      {INSIGHT_RULES.find((r) => r.id === item.rule_id)
                        ?.title || item.rule_id}
                    </EuiLink>
                  ),
                },
                {
                  field: "entity_name",
                  name: "Affected entity",
                  render: (name: string, item: Insight) => (
                    <span className="sm-insight-entity">
                      {name}
                      <small>{item.entity_type}</small>
                    </span>
                  ),
                },
                {
                  field: "severity",
                  name: "Severity",
                  width: "110px",
                  render: (severity: string) => (
                    <EuiBadge
                      color={severity === "critical" ? "danger" : "warning"}
                    >
                      {severity === "critical" ? "Critical" : "Warning"}
                    </EuiBadge>
                  ),
                },
                {
                  field: "status",
                  name: "Status",
                  width: "140px",
                  render: (_: string, item: Insight) =>
                    item.status === "resolved"
                      ? "Resolved"
                      : stale(item)
                        ? "Unverified"
                        : "Open",
                },
                {
                  field: "last_seen",
                  name: "Last observed",
                  render: (time: number) => date(time),
                },
                {
                  name: "Details",
                  width: "90px",
                  render: (item: Insight) => (
                    <EuiButtonEmpty
                      size="s"
                      aria-label={`View ${item.entity_name} ${item.rule_id}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      View
                    </EuiButtonEmpty>
                  ),
                },
              ]}
            />
          ) : (
            <EuiEmptyPrompt
              iconType="inspect"
              title={
                <h3>
                  {data.incidents.length
                    ? "No matching findings"
                    : "No findings in this time range"}
                </h3>
              }
              body={
                <p>
                  {data.incidents.length
                    ? "Try another search or status filter."
                    : "Findings appear after a check stays above its threshold for one minute (or below for disk space). This is not a guarantee that every aspect of the cluster is healthy."}
                </p>
              }
            />
          )}
        </>
      )}
      <EuiSpacer size="l" />
      <EuiAccordion
        id="sm-insight-rules"
        buttonContent="What is checked?"
        paddingSize="m"
      >
        <EuiText size="s">
          <p>
            Initial heuristic thresholds, evaluated on new monitoring samples.
            Missing data and gaps over 30 seconds reset detection and recovery
            windows. These checks identify symptoms and possible causes, not a
            confirmed root cause.
          </p>
        </EuiText>
        <div className="sm-insight-rules">
          {INSIGHT_RULES.map((rule) => (
            <div key={rule.id}>
              <strong>{rule.title}</strong>
              <span>
                {rule.metric.replace(/_/g, " ")} {rule.operator}{" "}
                {format(rule.threshold, rule.unit)} for 1 minute
              </span>
            </div>
          ))}
        </div>
      </EuiAccordion>
      {selected && selectedRule && (
        <EuiFlyout
          onClose={() => setSelectedId(null)}
          aria-labelledby="sm-insight-title"
          size="m"
        >
          <EuiFlyoutHeader hasBorder>
            <EuiBadge
              color={selected.severity === "critical" ? "danger" : "warning"}
            >
              {selected.severity}
            </EuiBadge>
            <EuiSpacer size="s" />
            <EuiTitle size="m">
              <h2 id="sm-insight-title">{selectedRule.title}</h2>
            </EuiTitle>
            <EuiText size="s">
              <p>{selected.entity_name}</p>
            </EuiText>
          </EuiFlyoutHeader>
          <EuiFlyoutBody className="sm-insight-detail">
            {stale(selected) && (
              <>
                <EuiCallOut color="warning" title="Awaiting fresh evidence">
                  <p>
                    The last valid observation is stale. This incident has not
                    been confirmed resolved.
                  </p>
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            )}
            <EuiText size="s">
              <p>{selectedRule.impact}</p>
              <h3>Observed evidence</h3>
              <dl className="sm-insight-facts">
                <div>
                  <dt>Last value during a breach</dt>
                  <dd>{format(selected.value, selectedRule.unit)}</dd>
                </div>
                <div>
                  <dt>Rule threshold</dt>
                  <dd>
                    {selectedRule.operator}{" "}
                    {format(selectedRule.threshold, selectedRule.unit)} for 1
                    minute
                  </dd>
                </div>
                <div>
                  <dt>First observed</dt>
                  <dd>{date(selected.first_seen)}</dd>
                </div>
                <div>
                  <dt>Detected</dt>
                  <dd>{date(selected.detected_at)}</dd>
                </div>
                <div>
                  <dt>Last observed</dt>
                  <dd>{date(selected.last_seen)}</dd>
                </div>
                <div>
                  <dt>Last evaluated</dt>
                  <dd>{date(selected.last_evaluated)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {selected.resolved_at
                      ? `Resolved ${date(selected.resolved_at)}`
                      : stale(selected)
                        ? "Unverified — awaiting fresh evidence"
                        : "Open"}
                  </dd>
                </div>
              </dl>
            </EuiText>
            {selected.evidence.length > 1 && (
              <ChartGrid
                dark={dark}
                specs={[
                  {
                    title: "Recent breach samples",
                    keys: [["value", selectedRule.metric.replace(/_/g, " ")]],
                    unit: selectedRule.unit,
                  },
                ]}
                points={selected.evidence.map((e) => ({
                  timestamp: e.timestamp,
                  metrics: { value: e.value },
                }))}
                range={{
                  from: selected.evidence[0].timestamp,
                  to: selected.evidence[selected.evidence.length - 1].timestamp,
                }}
              />
            )}
            <EuiSpacer size="m" />
            <EuiButton href={evidenceLink(selected)}>
              Open related monitoring charts
            </EuiButton>
            <EuiSpacer size="l" />
            <EuiText size="s">
              <h3>Possible causes</h3>
              <p>{selectedRule.causes}</p>
              <h3>Recommended next steps</h3>
              <ol>
                {selectedRule.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p>
                <EuiLink
                  href={selectedRule.docs}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  OpenSearch documentation
                </EuiLink>
              </p>
            </EuiText>
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </div>
  );
}
