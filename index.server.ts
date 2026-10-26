import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider";
import { createUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());
  server.registerUsageSource(createUsageSource());
  return () => {};
}
