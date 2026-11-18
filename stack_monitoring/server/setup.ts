import { constants, promises as fs } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { OpenSearchClient } from "../../../src/core/server";
import { at, record } from "../common/normalize";

export interface ManagedCredentials {
  version: 1;
  cluster_uuid: string;
  instance_uuid: string;
  username: string;
  password: string;
  ready: boolean;
}
export class SetupError extends Error {
  constructor(
    message: string,
    public statusCode = 409,
  ) {
    super(message);
  }
}
export function newCredentials(
  cluster: string,
  instance: string,
): ManagedCredentials {
  if (!cluster || cluster === "_na_" || !instance)
    throw new SetupError("Cluster or Dashboards identity is unavailable.");
  return {
    version: 1,
    cluster_uuid: cluster,
    instance_uuid: instance,
    username: `stack_monitoring_${randomBytes(16).toString("hex")}`,
    password: `Sm9!${randomBytes(32).toString("hex")}`,
    ready: false,
  };
}
function valid(value: unknown): value is ManagedCredentials {
  const item = record(value);
  return (
    item.version === 1 &&
    typeof item.cluster_uuid === "string" &&
    !!item.cluster_uuid &&
    item.cluster_uuid !== "_na_" &&
    typeof item.instance_uuid === "string" &&
    !!item.instance_uuid &&
    typeof item.username === "string" &&
    /^stack_monitoring_[a-f0-9]{32}$/.test(item.username) &&
    typeof item.password === "string" &&
    item.password.length >= 40 &&
    item.password.length <= 256 &&
    typeof item.ready === "boolean"
  );
}
async function privateDirectory(dataPath: string, create: boolean) {
  const directory = join(dataPath, "stack-monitoring");
  if (create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (record(error).code !== "EEXIST") throw error;
    }
  }
  try {
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new SetupError(
        "Managed collector directory must be private and owned by Dashboards.",
      );
  } catch (error) {
    if (!create && record(error).code === "ENOENT") return undefined;
    throw error;
  }
  if (create) {
    const parent = await fs.open(dataPath, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  return directory;
}
export async function readCredentials(
  dataPath: string,
): Promise<ManagedCredentials | undefined> {
  const directory = await privateDirectory(dataPath, false);
  if (!directory) return undefined;
  let handle;
  try {
    handle = await fs.open(
      join(directory, "collector.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (record(error).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.size > 4096 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new SetupError(
        "Managed collector credentials must be private and owned by Dashboards.",
      );
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new SetupError(
        "Managed collector credentials are invalid; restore the protected data directory.",
      );
    }
    if (!valid(value))
      throw new SetupError(
        "Managed collector credentials are invalid; restore the protected data directory.",
      );
    return value;
  } finally {
    await handle.close();
  }
}
export async function saveCredentials(
  dataPath: string,
  value: ManagedCredentials,
) {
  if (!valid(value))
    throw new SetupError("Invalid managed collector credentials.");
  const directory = (await privateDirectory(dataPath, true))!;
  const current = await readCredentials(dataPath);
  if (
    current &&
    JSON.stringify({ ...current, ready: false }) !==
      JSON.stringify({ ...value, ready: false })
  )
    throw new SetupError(
      "Managed collector identity conflict; existing credentials were preserved.",
    );
  const target = join(directory, "collector.json");
  const temporary = join(
    directory,
    `collector-${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (current) await fs.rename(temporary, target);
    else {
      await fs.link(temporary, target);
      await fs.unlink(temporary);
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  const parent = await fs.open(directory, constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function authorizeSetup(client: OpenSearchClient) {
  const result = await client.transport.request({
    method: "GET",
    path: "/_plugins/_security/api/permissionsinfo",
  });
  const disabled = record(at(result.body, "disabled_endpoints"));
  const denied = () =>
    new SetupError(
      "Set up monitoring requires a Security administrator with role and internal-user management permissions.",
      403,
    );
  if (
    typeof at(result.body, "has_api_access") !== "boolean" ||
    ["ROLES", "INTERNALUSERS"].some(
      (name) =>
        Array.isArray(disabled[name]) &&
        (disabled[name] as string[]).some((method) =>
          ["GET", "PUT"].includes(method),
        ),
    )
  )
    throw denied();
  if (at(result.body, "has_api_access") === true) return;
  // Granular restapi:admin permissions are not reflected in has_api_access.
  for (const [endpoint, name] of [
    ["roles", "stack_monitoring_collector"],
    ["internalusers", "stack_monitoring_setup_probe"],
  ]) {
    try {
      const response = await client.transport.request({
        method: "GET",
        path: `/_plugins/_security/api/${endpoint}/${name}`,
      });
      if (!record(response.body)[name]) throw denied();
    } catch (error) {
      if (
        Number(record(error).statusCode ?? at(error, "meta.statusCode")) !== 404
      )
        throw error;
    }
  }
}
export async function ensureCollectorIdentity(
  client: OpenSearchClient,
  value: ManagedCredentials,
) {
  const path = `/_plugins/_security/api/internalusers/${value.username}`;
  let existing: unknown;
  try {
    existing = (await client.transport.request({ method: "GET", path })).body;
  } catch (error) {
    if (
      Number(record(error).statusCode ?? at(error, "meta.statusCode")) !== 404
    )
      throw error;
  }
  if (existing) {
    const user = record(record(existing)[value.username]);
    if (
      at(user, "attributes.managed_by") !== "stackMonitoring" ||
      at(user, "attributes.cluster_uuid") !== value.cluster_uuid ||
      at(user, "attributes.instance_uuid") !== value.instance_uuid ||
      JSON.stringify(user.opendistro_security_roles) !==
        '["stack_monitoring_collector"]' ||
      JSON.stringify(user.backend_roles) !== "[]"
    )
      throw new SetupError(
        "Collector account conflict; the existing identity was not changed.",
      );
    return;
  }
  await client.transport.request({
    method: "PUT",
    path,
    body: {
      password: value.password,
      backend_roles: [],
      opendistro_security_roles: ["stack_monitoring_collector"],
      attributes: {
        managed_by: "stackMonitoring",
        cluster_uuid: value.cluster_uuid,
        instance_uuid: value.instance_uuid,
      },
      description:
        "Dedicated Stack Monitoring collector managed by its Dashboards instance",
    },
  });
}
