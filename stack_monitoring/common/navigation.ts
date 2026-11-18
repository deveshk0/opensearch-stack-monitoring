import type { EntityType } from "./types";
export function routeFromHash(hash: string) {
  const [path, search = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const views = [
    "clusters",
    "overview",
    "insights",
    "opensearch",
    "nodes",
    "indices",
    "pipelines",
    "processors",
    "dashboards",
    "instances",
  ];
  const view = views.includes(parts[0]) ? parts[0] : "overview";
  let id = "";
  try {
    id = decodeURIComponent(parts[1] || "");
  } catch {
    /* Invalid links fall back to the list. */
  }
  const types: Record<string, EntityType> = {
    nodes: "node",
    indices: "index",
    pipelines: "pipeline",
    processors: "processor",
    instances: "instance",
  };
  return {
    view,
    id,
    advanced: parts[2] === "advanced",
    type: id ? types[view] || "cluster" : ("cluster" as EntityType),
    params: new URLSearchParams(search),
  };
}
export function linkTo(path: string, params: URLSearchParams) {
  const query = params.toString();
  return `#${path}${query ? "?" + query : ""}`;
}
