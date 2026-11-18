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
import { createHash } from "crypto";
import {
  provisionResources,
  ResourceRequestError,
  ResourceValidationError,
} from "./setup_resources";
import {
  ManagedCredentials,
  SetupError,
  authorizeSetup,
  ensureCollectorIdentity,
  newCredentials,
  readCredentials,
  saveCredentials,
} from "./setup";

export class StackMonitoringPlugin {
  private config!: Config;
  private dataPath = "";
  private stopping = false;
  private managed?: ManagedCredentials;
  private setupError: string | null = null;
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
    const global = await this.context.config.legacy.globalConfig$
      .pipe(first())
      .toPromise();
    this.dataPath = global.path.data;
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
      {
        configured: () => !!this.collector,
        status: (client) => this.setupStatus(client),
        run: (client) => {
          const operation = this.settingsChange
            .catch(() => {})
            .then(() => this.setUpMonitoring(client));
          this.settingsChange = operation;
          return operation;
        },
      },
    );
    return {};
  }
  async start(core: CoreStart) {
    this.core = core;
    if (!this.config.collection.enabled) return {};
    if (this.config.collection.username || this.config.collection.password) {
      if (this.config.collection.username && this.config.collection.password) {
        this.configureCollector(this.config.collection);
        this.collector!.start();
      }
      return {};
    }
    try {
      this.managed = await readCredentials(this.dataPath);
      if (
        this.managed &&
        this.managed.instance_uuid !== this.context.env.instanceUuid
      )
        throw new SetupError(
          "Managed collector belongs to another Dashboards instance. Restore its original data directory or use manual recovery.",
        );
      if (this.managed?.ready) {
        this.configureCollector(this.managed);
        this.collector!.start();
      }
    } catch {
      this.setupError =
        "Managed collector credentials could not be loaded. Check ownership and private permissions on the persistent data directory.";
    }
    return {};
  }
  private configureCollector(credentials: {
    username: string;
    password: string;
  }) {
    const core = this.core!;
    this.client = core.opensearch.createClient("stack-monitoring-collector", {
      username: credentials.username,
      password: credentials.password,
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
  }
  private async setupStatus(client: OpenSearchClient) {
    await client.transport.request({ method: "GET", path: "/_cluster/health" });
    const status = {
      configured: !!this.collector,
      managed: !!this.managed,
      available: false,
      reason: null as string | null,
      last_success: this.collector?.state.last_success ?? null,
      last_error: this.collector?.state.last_error ?? null,
    };
    if (this.stopping) {
      status.reason = "Dashboards is stopping. Retry after restart.";
      return status;
    }
    if (status.configured) return status;
    if (!this.config.collection.enabled)
      status.reason =
        "Collection is disabled in the Dashboards server configuration.";
    else if (this.config.collection.username || this.config.collection.password)
      status.reason =
        "Complete the existing manual collector credentials, or remove both settings to use automatic setup.";
    else if (this.setupError) status.reason = this.setupError;
    else if (process.platform === "win32")
      status.reason =
        "Use manual collector configuration on Windows; automatic setup requires private POSIX file permissions.";
    else {
      try {
        await authorizeSetup(client);
        status.available = true;
      } catch (error) {
        if (
          Number(record(error).statusCode ?? at(error, "meta.statusCode")) !==
          403
        )
          throw error;
        status.reason =
          "Ask a Security administrator to set up monitoring for this cluster.";
      }
    }
    return status;
  }
  private async setUpMonitoring(client: OpenSearchClient) {
    if (this.stopping)
      throw new SetupError("Dashboards is stopping. Retry after restart.", 503);
    await authorizeSetup(client);
    const status = await this.setupStatus(client);
    if (status.configured) return status;
    if (!status.available)
      throw new SetupError(status.reason || "Setup is unavailable.");
    if (!this.core)
      throw new SetupError("Dashboards is still starting. Retry shortly.", 503);
    const info = (await client.transport.request({ method: "GET", path: "/" }))
      .body;
    const cluster = String(at(info, "cluster_uuid") || "");
    const health = (
      await client.transport.request({
        method: "GET",
        path: "/_cluster/health",
      })
    ).body;
    const dataNodes = Number(at(health, "number_of_data_nodes"));
    if (!Number.isInteger(dataNodes) || dataNodes < 1)
      throw new SetupError(
        "At least one healthy data node is required for monitoring setup.",
      );
    const credentials =
      this.managed ?? newCredentials(cluster, this.context.env.instanceUuid);
    if (
      credentials.cluster_uuid !== cluster ||
      credentials.instance_uuid !== this.context.env.instanceUuid
    )
      throw new SetupError(
        "Managed collector identity does not match this cluster and Dashboards instance.",
      );
    const lock = `/.stack-monitoring-locks-v1/_doc/${createHash("sha256").update(cluster).digest("hex")}`;
    try {
      const owner = at(
        (await client.transport.request({ method: "GET", path: lock })).body,
        "_source.owner",
      );
      if (owner !== this.context.env.instanceUuid)
        throw new SetupError(
          "Another Dashboards instance owns collection. Stop it and follow ownership recovery before setting up this instance.",
        );
    } catch (error) {
      if (
        Number(record(error).statusCode ?? at(error, "meta.statusCode")) !== 404
      )
        throw error;
    }
    // Persist before creating the account so an interrupted setup can reuse its secret.
    await saveCredentials(this.dataPath, credentials);
    this.managed = credentials;
    let stage = "resources";
    try {
      await provisionResources(client, dataNodes > 1 ? 1 : 0);
      stage = "collector identity";
      await ensureCollectorIdentity(client, credentials);
      stage = "collector authentication";
      this.configureCollector(credentials);
      const account = (
        await this.client!.asInternalUser.transport.request({
          method: "GET",
          path: "/_plugins/_security/api/account",
        })
      ).body;
      if (
        JSON.stringify(at(account, "roles")) !==
        '["stack_monitoring_collector"]'
      )
        throw new SetupError(
          "The generated collector did not receive exactly the scoped collector role. Check authentication and global role mappings.",
        );
      stage = "ownership";
      await this.ownership!.acquire(cluster);
      stage = "credential persistence";
      this.managed = { ...credentials, ready: true };
      await saveCredentials(this.dataPath, this.managed);
      stage = "collection";
      await saveCollectionSetting(client, true, async () => {});
      await this.collector!.runOnce();
      this.collector!.start(false);
      return await this.setupStatus(client);
    } catch (error) {
      await this.stopCollector();
      this.context.logger
        .get()
        .warn(
          `Monitoring setup failed during ${stage} (HTTP ${record(error).statusCode ?? at(error, "meta.statusCode") ?? "unknown"}). ${error instanceof ResourceRequestError || error instanceof ResourceValidationError || error instanceof SetupError ? error.message : "Check setup privileges and monitoring resources."}`,
        );
      throw error;
    }
  }
  private changeCollection(client: OpenSearchClient, enabled: boolean) {
    const change = this.settingsChange
      .catch(() => {})
      .then(async () => {
        if (this.stopping)
          throw new SetupError(
            "Dashboards is stopping. Retry after restart.",
            503,
          );
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
    if (
      this.managed &&
      at(values.info, "cluster_uuid") !== this.managed.cluster_uuid
    )
      throw new SetupError("Collector credentials belong to another cluster.");
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
    this.stopping = true;
    await this.settingsChange.catch(() => {});
    await this.stopCollector();
  }
  private async stopCollector() {
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
    this.collector = undefined;
    this.ownership = undefined;
    this.subscription = undefined;
    this.client = undefined;
  }
}
