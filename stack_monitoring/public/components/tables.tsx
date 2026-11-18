import {
  EuiInMemoryTable,
  EuiHealth,
  EuiLink,
  EuiBadge,
  EuiFieldSearch,
  EuiSpacer,
} from "@elastic/eui";
import type { EuiBasicTableColumn } from "@elastic/eui";
import type { Entity, Shard, Recovery } from "../../common/types";
import { format, Unit } from "./charts";

export function Health({ status }: { status: string }) {
  const color = ["green", "online", "healthy"].includes(status)
    ? "success"
    : ["yellow", "warning", "stale"].includes(status)
      ? "warning"
      : ["red", "offline"].includes(status)
        ? "danger"
        : "subdued";
  return (
    <EuiHealth color={color}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </EuiHealth>
  );
}
export interface MetricColumn {
  key: string;
  name: string;
  unit?: Unit;
}
export function EntityTable({
  items,
  columns,
  href,
  query,
  onQuery,
  caption,
}: {
  items: Entity[];
  columns: MetricColumn[];
  href: (e: Entity) => string;
  query: string;
  onQuery: (q: string) => void;
  caption: string;
}) {
  const cols: EuiBasicTableColumn<Entity>[] = [
    {
      field: "name",
      name: "Name",
      sortable: true,
      render: (name: string, e: Entity) => (
        <div>
          <EuiLink href={href(e)}>{name}</EuiLink>
          {e.address && <div className="sm-muted sm-small">{e.address}</div>}
        </div>
      ),
    },
    {
      field: "status",
      name: "Status",
      sortable: true,
      render: (status: string) => <Health status={status} />,
    },
    ...columns.map((c) => ({
      field: `metrics.${c.key}`,
      name: c.name,
      sortable: true,
      render: (v: number | null) => format(v, c.unit),
    })),
  ];
  return (
    <>
      <EuiFieldSearch
        fullWidth
        aria-label={`Filter ${caption.toLowerCase()}`}
        placeholder={`Filter ${caption.toLowerCase()}…`}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <EuiSpacer size="m" />
      <EuiInMemoryTable
        items={items.filter((e) =>
          [e.name, e.address, ...(e.roles || [])]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
        )}
        itemId="id"
        columns={cols}
        tableCaption={caption}
        sorting
        pagination={{ initialPageSize: 10, pageSizeOptions: [10, 25, 50] }}
        message="No matching entries in this time range."
      />
    </>
  );
}
export function ShardTable({
  shards,
  href,
}: {
  shards: Shard[];
  href: (path: string) => string;
}) {
  return (
    <EuiInMemoryTable<Shard>
      items={shards}
      tableCaption="Shard allocation"
      pagination={{ initialPageSize: 10, pageSizeOptions: [10, 25, 50] }}
      sorting
      search={{ box: { incremental: true, placeholder: "Filter shards…" } }}
      columns={[
        {
          field: "index",
          name: "Index",
          sortable: true,
          render: (name: string) => (
            <EuiLink href={href(`/indices/${encodeURIComponent(name)}`)}>
              {name}
            </EuiLink>
          ),
        },
        { field: "shard", name: "Shard", sortable: true },
        {
          field: "primary",
          name: "Type",
          render: (primary: boolean) => (
            <EuiBadge color={primary ? "primary" : "hollow"}>
              {primary ? "Primary" : "Replica"}
            </EuiBadge>
          ),
        },
        {
          field: "state",
          name: "State",
          sortable: true,
          render: (state: string) => (
            <EuiHealth
              color={
                state === "STARTED"
                  ? "success"
                  : state === "UNASSIGNED"
                    ? "danger"
                    : "warning"
              }
            >
              {state}
            </EuiHealth>
          ),
        },
        { field: "node", name: "Node", sortable: true },
      ]}
    />
  );
}
export function RecoveryTable({ items }: { items: Recovery[] }) {
  return (
    <EuiInMemoryTable
      items={items}
      tableCaption="Shard recoveries"
      pagination={{ initialPageSize: 10 }}
      sorting
      columns={[
        { field: "index", name: "Index", sortable: true },
        { field: "shard", name: "Shard" },
        { field: "stage", name: "Stage", sortable: true },
        { field: "time", name: "Time" },
        { field: "source", name: "Source" },
        { field: "target", name: "Destination" },
        { field: "files", name: "Files recovered" },
        { field: "bytes", name: "Bytes recovered" },
      ]}
      message="No shard recoveries in this sample."
    />
  );
}
