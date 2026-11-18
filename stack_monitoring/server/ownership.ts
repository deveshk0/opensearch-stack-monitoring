import { createHash } from "crypto";
import type { OpenSearchClient } from "../../../src/core/server";
import { at, record } from "../common/normalize";
const status = (error: unknown) =>
  record(error).statusCode ?? at(error, "meta.statusCode");
// shortcut: a persistent, unique Dashboards UUID owns collection; automatic failover needs fencing.
export class CollectorOwnership {
  private held?: { path: string; seq: number; term: number };
  constructor(
    private client: OpenSearchClient,
    private owner: string,
  ) {
    if (!owner.trim()) throw new Error("Collector identity unavailable");
  }
  async acquire(cluster: string) {
    if (!cluster.trim() || cluster === "_na_")
      throw new Error("Cluster identity unavailable");
    const id = createHash("sha256").update(cluster).digest("hex");
    const path = `/.stack-monitoring-locks-v1/_doc/${id}`;
    if (this.held && this.held.path !== path) await this.release();
    let result;
    try {
      result = await this.client.transport.request(
        {
          method: "PUT",
          path: `/.stack-monitoring-locks-v1/_create/${id}`,
          body: { owner: this.owner },
        },
        { maxRetries: 0, requestTimeout: 20000 },
      );
    } catch (error) {
      if (status(error) !== 409) throw error;
      const current = await this.client.transport.request(
        {
          method: "GET",
          path,
        },
        { maxRetries: 0, requestTimeout: 20000 },
      );
      if (at(current.body, "_source.owner") !== this.owner)
        throw new Error(
          "Monitoring collection belongs to another Dashboards instance",
        );
      result = await this.client.transport.request(
        {
          method: "PUT",
          path,
          querystring: {
            if_seq_no: at(current.body, "_seq_no"),
            if_primary_term: at(current.body, "_primary_term"),
          },
          body: { owner: this.owner },
        },
        { maxRetries: 0, requestTimeout: 20000 },
      );
    }
    this.held = {
      path,
      seq: Number(at(result.body, "_seq_no")),
      term: Number(at(result.body, "_primary_term")),
    };
  }
  async release() {
    const held = this.held;
    if (!held) return;
    try {
      await this.client.transport.request(
        {
          method: "DELETE",
          path: held.path,
          querystring: { if_seq_no: held.seq, if_primary_term: held.term },
        },
        { maxRetries: 0, requestTimeout: 20000 },
      );
    } catch (error) {
      if (status(error) !== 404 && status(error) !== 409) throw error;
    }
    this.held = undefined;
  }
}
