import { useState } from "react";
import { usePollingEffect } from "../use_polling_effect";
import {
  EuiPopover,
  EuiButtonEmpty,
  EuiButton,
  EuiTitle,
  EuiText,
  EuiSpacer,
  EuiHealth,
  EuiCallOut,
  EuiLoadingSpinner,
} from "@elastic/eui";
import type { CoreStart } from "../../../../src/core/public";
import type { MonitoringResponse } from "../../common/types";
type Status = MonitoringResponse["collection"] & {
  configured: boolean;
  desired_enabled: boolean;
  index_pattern: string;
  interval_ms: number;
};
export function CollectionControl({
  core,
  tick,
  onChange,
}: {
  core: CoreStart;
  tick: number;
  onChange: (state: MonitoringResponse["collection"]) => void;
}) {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [busy, setBusy] = useState(false);
  usePollingEffect(
    (isCurrent) => {
      if (busy) return Promise.resolve();
      return core.http
        .get<Status>("/api/stack_monitoring/collection")
        .then((value) => {
          if (isCurrent()) {
            setStatus(value);
            setReadError("");
          }
        })
        .catch(() => {
          if (isCurrent()) {
            setStatus(null);
            setReadError(
              "Self-monitoring settings are unavailable. Check your permissions and the settings index.",
            );
          }
        });
    },
    [core, busy],
    tick,
  );
  const change = async () => {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      const state = await core.http.post<MonitoringResponse["collection"]>(
        "/api/stack_monitoring/collection",
        { body: JSON.stringify({ enabled: !status.enabled }) },
      );
      setStatus({ ...status, ...state, desired_enabled: state.enabled });
      onChange(state);
    } catch (e) {
      setError(e.body?.message || "The collection setting could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <EuiPopover
      isOpen={open}
      closePopover={() => setOpen(false)}
      anchorPosition="downRight"
      button={
        <EuiButtonEmpty iconType="gear" onClick={() => setOpen(!open)}>
          Self-monitoring
        </EuiButtonEmpty>
      }
    >
      <div className="sm-collection-settings">
        <EuiTitle size="s">
          <h2>Self-monitoring</h2>
        </EuiTitle>
        <EuiSpacer size="m" />
        {!status && !error && !readError && <EuiLoadingSpinner />}
        {status && (
          <>
            <EuiHealth color={status.enabled ? "success" : "subdued"}>
              {status.enabled ? "Enabled" : "Disabled"}
            </EuiHealth>
            <EuiSpacer size="s" />
            <EuiText size="s">
              <p>Collect OpenSearch and Dashboards metrics in this cluster.</p>
              <dl>
                <dt>History index</dt>
                <dd>
                  <code>{status.index_pattern}</code>
                </dd>
                <dt>Collection interval</dt>
                <dd>Every {status.interval_ms / 1000} seconds</dd>
                <dt>Last collected sample</dt>
                <dd>
                  {status.last_success
                    ? new Date(status.last_success).toLocaleString()
                    : "No sample collected since startup"}
                </dd>
              </dl>
            </EuiText>
            <EuiSpacer size="m" />
            {status.last_error && (
              <>
                <EuiCallOut color="warning" title={status.last_error} />
                <EuiSpacer size="m" />
              </>
            )}
            {!status.configured ? (
              <EuiCallOut color="warning" title="Collector is not configured">
                <p>
                  Configure collector credentials and enable collection in the
                  Dashboards server configuration.
                </p>
              </EuiCallOut>
            ) : (
              <>
                <EuiButton
                  fill={!status.enabled}
                  isLoading={busy}
                  onClick={change}
                >
                  {status.enabled
                    ? "Disable self-monitoring"
                    : "Enable self-monitoring"}
                </EuiButton>
                <EuiSpacer size="s" />
                <EuiText size="xs" color="subdued">
                  <p>
                    Disabling collection keeps existing history. The setting
                    survives restarts.
                  </p>
                </EuiText>
              </>
            )}
          </>
        )}
        {(error || readError) && (
          <>
            <EuiSpacer size="s" />
            <EuiCallOut color="danger" title={error || readError} />
          </>
        )}
      </div>
    </EuiPopover>
  );
}
