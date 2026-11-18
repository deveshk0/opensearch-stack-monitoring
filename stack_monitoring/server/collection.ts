import type { OpenSearchClient } from "../../../src/core/server";
import { at } from "../common/normalize";
export const COLLECTION_PATH = "/.stack-monitoring-settings/_doc/collection";
export async function readCollectionSetting(
  client: OpenSearchClient,
): Promise<boolean> {
  const result = await client.transport.request(
    {
      method: "GET",
      path: COLLECTION_PATH,
    },
    { maxRetries: 0, requestTimeout: 20000 },
  );
  const enabled = at(result.body, "_source.enabled");
  if (typeof enabled !== "boolean")
    throw new Error("Invalid collection setting");
  return enabled;
}
export async function saveCollectionSetting(
  client: OpenSearchClient,
  enabled: boolean,
  apply: (enabled: boolean) => Promise<void>,
) {
  await client.transport.request(
    {
      method: "PUT",
      path: COLLECTION_PATH,
      querystring: { refresh: "wait_for" },
      body: { enabled },
    },
    { maxRetries: 0, requestTimeout: 20000 },
  );
  await apply(enabled);
}
