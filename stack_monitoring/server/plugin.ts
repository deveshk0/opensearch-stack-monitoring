import type {
  CoreSetup,
  CoreStart,
  PluginInitializerContext,
  ICustomClusterClient,
  OpsMetrics,
  OpenSearchClient,
} from "../../../src/core/server";
import type { Subscription } from "rxjs";
import { first } from "rxjs/operators";
import type { Config } from "./index";
import type { RawSnapshot, Snapshot } from "../common/types";
import { record, at } from "../common/normalize";
import { writeSnapshot } from "./writer";
import { CollectorOwnership } from "./ownership";
import { Collector } from "./collector";
import { InsightStore } from "./insights";
import { defineRoutes } from "./routes";
import { readCollectionSetting, saveCollectionSetting } from "./collection";

export class StackMonitoringPlugin {
  private config!: Config;
  private settingsChange: Promise<unknown> = Promise.resolve();
  private collector?: Collector;
  private insights?: InsightStore;
  private ownership?: CollectorOwnership;
  private client?: ICustomClusterClient;
  private subscription?: Subscription;
  private metrics?: OpsMetrics;
  private core?: CoreStart;
  constructor(private context: PluginInitializerContext) {}
  async setup(core: CoreSetup) {
    this.config = await this.context.config
      .create<Config>()
      .pipe(first())
      .toPromise();
    defineRoutes(
      core.http.createRouter(),
      this.config,
      () =>
        this.collector?.state ?? {
          enabled: false,
          last_success: null,
          last_error: "Collection is not configured.",
          collecting: false,
          insights_error: null,
        },
      (client, enabled) => this.changeCollection(client, enabled),
    );
    return {};
  }
  async start(core: CoreStart) {
    this.core = core;
    if (
      !this.config.collection.enabled ||
      !this.config.collection.username ||
      !this.config.collection.password
    )
      return {};
    this.client = core.opensearch.createClient("stack-monitoring-collector", {
      username: this.config.collection.username,
      password: this.config.collection.password,
      requestTimeout: 20000,
    });
    this.subscription = core.metrics.getOpsMetrics$().subscribe((metrics) => {
      this.metrics = metrics;
    });
    this.ownership = new CollectorOwnership(
      this.client.asInternalUser,
      this.context.env.instanceUuid,
    );
    this.insights = new InsightStore(
      this.client.asInternalUser,
      this.config.collection.resolvedRetentionDays,
    );
    this.collector = new Collector(
      () => this.read(),
      (snapshot) => this.write(snapshot),
      (error) =>
        this.context.logger
          .get()
          .warn(
            `Monitoring collection failed (HTTP ${record(error).statusCode ?? at(error, "meta.statusCode") ?? "unknown"}). Check collector privileges and cluster connectivity.`,
          ),
      async () => {
        const enabled = await readCollectionSetting(
          this.client!.asInternalUser,
        );
        if (!enabled) await this.ownership!.release();
        return enabled;
      },
      (snapshot) => this.insights!.collect(snapshot),
    );
    this.collector.start();
    return {};
  }
  private changeCollection(client: OpenSearchClient, enabled: boolean) {
    const change = this.settingsChange
      .catch(() => {})
      .then(async () => {
        if (!this.collector) throw new Error("Collection is not configured");
        await saveCollectionSetting(client, enabled, (value) =>
          this.collector!.setEnabled(value),
        );
        if (!enabled) await this.ownership?.release();
        return this.collector.state;
      });
    this.settingsChange = change;
    return change;
  }
  private async read(): Promise<RawSnapshot> {
    const timestamp = Date.now();
    const endpoints = {
      info: "/",
      health: "/_cluster/health",
      cluster: "/_cluster/stats",
      nodeStats: "/_nodes/stats",
      nodeInfo: "/_nodes/_all/os,jvm",
      indexStats: "/_stats",
      shards: "/_cat/shards?format=json&h=index,shard,prirep,state,node",
      recovery:
        "/_cat/recovery?format=json&h=index,shard,stage,source_node,target_node,time,files_percent,bytes_percent",
    };
    const entries = Object.entries(endpoints);
    const results = await Promise.allSettled(
      entries.map(([, path]) =>
        this.client!.asInternalUser.transport.request(
          { method: "GET", path },
          { maxRetries: 0, requestTimeout: 20000 },
        ),
      ),
    );
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i],
        result = results[i];
      if (result.status === "fulfilled") {
        values[name] = result.value.body;
        if (
          Number(at(result.value.body, "_nodes.failed")) > 0 ||
          Number(at(result.value.body, "_shards.failed")) > 0
        )
          errors.push(`${name}: some nodes or shards did not respond.`);
      } else {
        values[name] = null;
        errors.push(`${name}: unavailable.`);
      }
    }
    if (!values.info || !values.health)
      throw new Error("Cluster metadata unavailable");
    await this.ownership!.acquire(
      String(at(values.info, "cluster_uuid") || ""),
    );
    const server = this.core!.http.getServerInfo();
    return {
      ...values,
      timestamp,
      dashboards: this.metrics,
      instance: {
        id: this.context.env.instanceUuid,
        name: server.name,
        version: this.context.env.packageInfo.version,
        address: `${server.hostname}:${server.port}`,
      },
      errors,
    } as RawSnapshot;
  }
  private async write(snapshot: Snapshot) {
    await writeSnapshot(this.client!.asInternalUser, snapshot);
  }

  async stop() {
    await this.settingsChange.catch(() => {});
    await this.collector?.stop();
    try {
      await this.ownership?.release();
    } catch {
      this.context.logger
        .get()
        .warn(
          "Could not release monitoring ownership; verify the former collector is stopped before manual recovery.",
        );
    }
    this.subscription?.unsubscribe();
    await this.client?.close();
  }
}
