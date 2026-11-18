import { schema, TypeOf } from "@osd/config-schema";
import type { PluginInitializerContext } from "../../../src/core/server";
import { StackMonitoringPlugin } from "./plugin";
export const config = {
  schema: schema.object({
    enabled: schema.boolean({ defaultValue: true }),
    collection: schema.object({
      enabled: schema.boolean({ defaultValue: true }),
      username: schema.string({ defaultValue: "" }),
      password: schema.string({ defaultValue: "" }),
      resolvedRetentionDays: schema.number({
        defaultValue: 30,
        min: 1,
        max: 3650,
        validate: (value) =>
          Number.isInteger(value) ? undefined : "Must be an integer",
      }),
    }),
    logs: schema.object({ index: schema.string({ defaultValue: "" }) }),
  }),
};
export type Config = TypeOf<typeof config.schema>;
export function plugin(context: PluginInitializerContext) {
  return new StackMonitoringPlugin(context);
}
