import { useRef, useState } from "react";
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
type SetupStatus = {
  configured: boolean;
  managed: boolean;
  available: boolean;
  reason: string | null;
  last_success: number | null;
  last_error: string | null;
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
    [busy, setBusy] = useState(false),
    [setup, setSetup] = useState<SetupStatus | null>(null),
    [retry, setRetry] = useState(0);
  const setupPending = useRef(false);
  usePollingEffect(
    async (isCurrent) => {
      if (busy) return;
      try {
        const value = await core.http.get<Status>(
          "/api/stack_monitoring/collection",
        );
        if (!isCurrent()) return;
        setStatus(value);
        setReadError("");
        if (value.configured) return;
      } catch {
        if (!isCurrent()) return;
        setStatus(null);
      }
      try {
        const value = await core.http.get<SetupStatus>(
          "/api/stack_monitoring/setup",
        );
        if (!isCurrent()) return;
        setSetup(value);
        setReadError("");
      } catch {
        if (!isCurrent()) return;
        setSetup(null);
        setReadError(
          "Self-monitoring settings are unavailable. Check your permissions and retry.",
        );
      }
    },
    [core, busy, retry],
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
  const setUp = async () => {
    if (!setup?.available || setup.configured || setupPending.current) return;
    setupPending.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await core.http.post<SetupStatus>(
        "/api/stack_monitoring/setup",
        { body: JSON.stringify({}) },
      );
      setSetup(state);
      if (state.configured) {
        setReadError("");
        onChange({
          enabled: true,
          last_success: state.last_success,
          last_error: state.last_error,
          collecting: false,
        });
      } else {
        setError("Monitoring setup could not be completed. Please retry.");
      }
    } catch (error) {
      setError(
        (error?.response?.status === 409 || error?.body?.statusCode === 409) &&
          typeof error?.body?.message === "string" &&
          error.body.message
          ? error.body.message
          : "Monitoring setup could not be completed. Please retry.",
      );
    } finally {
      setupPending.current = false;
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
          {setup && !setup.configured && !status?.configured
            ? "Set up monitoring"
            : "Self-monitoring"}
        </EuiButtonEmpty>
      }
    >
      <div className="sm-collection-settings">
        <EuiTitle size="s">
          <h2>Self-monitoring</h2>
        </EuiTitle>
        <EuiSpacer size="m" />
        {!status?.configured && !setup && !readError && <EuiLoadingSpinner />}
        {!status?.configured && setup && (
          <>
            {setup.configured ? (
              <EuiHealth color={setup.last_success ? "success" : "warning"}>
                {setup.last_success
                  ? "Collecting monitoring samples"
                  : "Waiting for the first collected sample"}
              </EuiHealth>
            ) : (
              <>
                <EuiText size="s">
                  <p>
                    Set up monitoring indices, retention, and a scoped collector
                    using your current administrator session. Collector
                    credentials stay on the Dashboards server.
                  </p>
                </EuiText>
                <EuiSpacer size="m" />
                {setup.available ? (
                  <EuiButton
                    fill
                    isLoading={busy}
                    isDisabled={busy}
                    onClick={setUp}
                  >
                    Set up monitoring
                  </EuiButton>
                ) : (
                  <EuiCallOut color="warning" title="Setup is unavailable">
                    <p>
                      {setup.reason ||
                        "Ask an administrator to configure monitoring."}
                    </p>
                  </EuiCallOut>
                )}
              </>
            )}
            {setup.last_error && (
              <>
                <EuiSpacer size="s" />
                <EuiCallOut color="warning" title={setup.last_error} />
              </>
            )}
          </>
        )}
        {status?.configured && (
          <>
            <EuiHealth
              color={
                !status.enabled
                  ? "subdued"
                  : status.last_success
                    ? "success"
                    : "warning"
              }
            >
              {!status.enabled
                ? "Disabled"
                : status.last_success
                  ? "Enabled"
                  : "Waiting for the first collected sample"}
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
            <EuiButton fill={!status.enabled} isLoading={busy} onClick={change}>
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
        {(error || readError) && (
          <>
            <EuiSpacer size="s" />
            <EuiCallOut color="danger" title={error || readError} />
            {readError && (
              <>
                <EuiSpacer size="s" />
                <EuiButton onClick={() => setRetry((value) => value + 1)}>
                  Retry
                </EuiButton>
              </>
            )}
          </>
        )}
      </div>
    </EuiPopover>
  );
}
