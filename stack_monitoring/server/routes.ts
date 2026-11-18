import { SetupError } from "./setup";
import { schema } from "@osd/config-schema";
import type {
  IRouter,
  RequestHandlerContext,
  OpenSearchClient,
  OpenSearchDashboardsResponseFactory,
} from "../../../src/core/server";
import type { Config } from "./index";
import type { Collector } from "./collector";
import { readInsights } from "./insights";
import { readHistory } from "./history";
import { readCollectionSetting } from "./collection";
import { at, record } from "../common/normalize";
import { parseRange, MONITORING_INDEX } from "../common/metrics";

function requireCompleteSearch(body: unknown) {
  if (at(body, "timed_out") === true || Number(at(body, "_shards.failed")) > 0)
    throw new Error("Monitoring search returned incomplete results");
}

function failure(
  error: unknown,
  response: OpenSearchDashboardsResponseFactory,
) {
  if (error instanceof RangeError)
    return response.badRequest({ body: error.message });
  const status = Number(
    record(error).statusCode ?? at(error, "meta.statusCode"),
  );
  if (status === 401 || status === 403)
    return response.forbidden({
      body: `Stack Monitoring requires cluster monitoring and read access to ${MONITORING_INDEX}.`,
    });
  return response.customError({
    statusCode: 503,
    body: "Monitoring data is unavailable. Check the cluster connection and collector permissions.",
  });
}
export function defineRoutes(
  router: IRouter,
  config: Config,
  state: () => Collector["state"],
  changeCollection: (
    client: OpenSearchClient,
    enabled: boolean,
  ) => Promise<Collector["state"]>,
  setup?: {
    configured: () => boolean;
    status: (client: OpenSearchClient) => Promise<Record<string, unknown>>;
    run: (client: OpenSearchClient) => Promise<Record<string, unknown>>;
  },
) {
  const configured = () =>
    setup?.configured() ??
    Boolean(
      config.collection.enabled &&
      config.collection.username &&
      config.collection.password,
    );
  if (setup) {
    const handle =
      (run: boolean) =>
      async (
        context: RequestHandlerContext,
        request: unknown,
        response: OpenSearchDashboardsResponseFactory,
      ) => {
        try {
          const client = context.core.opensearch.client.asCurrentUser;
          return response.ok({
            body: await (run ? setup.run(client) : setup.status(client)),
          });
        } catch (error) {
          const status = Number(
            record(error).statusCode ?? at(error, "meta.statusCode"),
          );
          if (status === 401 || status === 403)
            return response.forbidden({
              body: "Set up monitoring requires an authorized Security administrator.",
            });
          return response.customError({
            statusCode: error instanceof SetupError ? error.statusCode : 503,
            body:
              error instanceof SetupError
                ? error.message
                : "Setup could not finish. Check administrator permissions, existing monitoring resources, and Dashboards server logs, then retry.",
          });
        }
      };
    router.get(
      { path: "/api/stack_monitoring/setup", validate: false },
      handle(false),
    );
    router.post(
      {
        path: "/api/stack_monitoring/setup",
        validate: { body: schema.object({}) },
      },
      handle(true),
    );
  }
  router.get(
    { path: "/api/stack_monitoring/collection", validate: false },
    async (context, request, response) => {
      try {
        const client = context.core.opensearch.client.asCurrentUser;
        await client.transport.request({
          method: "GET",
          path: "/_cluster/health",
        });
        const desired_enabled = await readCollectionSetting(client);
        return response.ok({
          body: {
            ...state(),
            desired_enabled,
            configured: configured(),
            index_pattern: MONITORING_INDEX,
            interval_ms: 10000,
          },
        });
      } catch (error) {
        return failure(error, response);
      }
    },
  );
  router.post(
    {
      path: "/api/stack_monitoring/collection",
      validate: { body: schema.object({ enabled: schema.boolean() }) },
    },
    async (context, request, response) => {
      try {
        const client = context.core.opensearch.client.asCurrentUser;
        await client.transport.request({
          method: "GET",
          path: "/_cluster/health",
        });
        if (!configured())
          return response.badRequest({
            body: "Collection is disabled in server configuration or collector credentials are missing.",
          });
        return response.ok({
          body: await changeCollection(client, request.body.enabled),
        });
      } catch (error) {
        const code = Number(
          record(error).statusCode ?? at(error, "meta.statusCode"),
        );
        if (code === 401 || code === 403)
          return response.forbidden({
            body: "Changing self-monitoring requires write access to .stack-monitoring-settings.",
          });
        return failure(error, response);
      }
    },
  );
  const time = {
    from: schema.string({ defaultValue: "now-15m", maxLength: 64 }),
    to: schema.string({ defaultValue: "now", maxLength: 64 }),
  };
  router.get(
    {
      path: "/api/stack_monitoring/insights",
      validate: { query: schema.object(time) },
    },
    async (context, request, response) => {
      try {
        return response.ok({
          body: {
            ...(await readInsights(
              context.core.opensearch.client.asCurrentUser,
              request.query,
            )),
            collection: state(),
          },
        });
      } catch (error) {
        const code = Number(
          record(error).statusCode ?? at(error, "meta.statusCode"),
        );
        if (code === 401 || code === 403)
          return response.forbidden({
            body: "Insights requires cluster monitoring and read access to stack-monitoring-insights-v1.",
          });
        if (error instanceof RangeError)
          return response.badRequest({ body: error.message });
        return response.customError({
          statusCode: 503,
          body: "Insights are unavailable. Check the findings index, collector permissions and cluster connectivity.",
        });
      }
    },
  );
  router.get(
    {
      path: "/api/stack_monitoring/history",
      validate: {
        query: schema.object({
          ...time,
          type: schema.oneOf(
            [
              schema.literal("cluster"),
              schema.literal("node"),
              schema.literal("index"),
              schema.literal("pipeline"),
              schema.literal("processor"),
              schema.literal("instance"),
            ],
            { defaultValue: "cluster" },
          ),
          id: schema.string({
            defaultValue: "cluster",
            minLength: 1,
            maxLength: 4096,
          }),
        }),
      },
    },
    async (context, request, response) => {
      try {
        return response.ok({
          body: {
            ...(await readHistory(
              context.core.opensearch.client.asCurrentUser,
              request.query,
            )),
            collection: state(),
          },
        });
      } catch (error) {
        return failure(error, response);
      }
    },
  );
  router.get(
    { path: "/api/stack_monitoring/status", validate: false },
    async (context, request, response) => {
      try {
        const client = context.core.opensearch.client.asCurrentUser;
        await client.transport.request({
          method: "GET",
          path: "/_cluster/health",
        });
        const result = await client.transport.request({
          method: "POST",
          path: `/${MONITORING_INDEX}/_search`,
          querystring: { ignore_unavailable: true },
          body: { size: 0 },
        });
        requireCompleteSearch(result.body);
        return response.ok({ body: state() });
      } catch (error) {
        return failure(error, response);
      }
    },
  );
  router.get(
    {
      path: "/api/stack_monitoring/logs",
      validate: { query: schema.object(time) },
    },
    async (context, request, response) => {
      try {
        const range = parseRange(request.query.from, request.query.to);
        const client = context.core.opensearch.client.asCurrentUser;
        await client.transport.request({
          method: "GET",
          path: "/_cluster/health",
        });
        if (!config.logs.index)
          return response.ok({ body: { configured: false, entries: [] } });
        const result = await client.transport.request({
          method: "POST",
          path: `/${encodeURIComponent(config.logs.index)}/_search`,
          querystring: { ignore_unavailable: true },
          body: {
            size: 10,
            sort: [{ "@timestamp": "desc" }],
            query: {
              range: { "@timestamp": { gte: range.from, lte: range.to } },
            },
            _source: ["@timestamp", "message", "log.level", "node.name"],
          },
        });
        requireCompleteSearch(result.body);
        const entries = at(result.body, "hits.hits");
        if (!Array.isArray(entries))
          throw new Error("Invalid log search response");
        return response.ok({
          body: {
            configured: true,
            entries,
          },
        });
      } catch (error) {
        return failure(error, response);
      }
    },
  );
}
