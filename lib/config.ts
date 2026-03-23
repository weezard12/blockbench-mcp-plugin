import process from "process";
import {
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_MCP_PORT,
  MCP_PORT_LAUNCH_ARG,
} from "@/lib/constants";

export interface ResolvedMcpServerConfig {
  endpoint: string;
  port: number;
  portSource: "default" | "launch-arg" | "settings";
}

function parsePort(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const parsedPort = Number(trimmedValue);
  return Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : null;
}

function resolveLaunchArgumentPort(argv: string[]): number | null {
  let portOverride: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === MCP_PORT_LAUNCH_ARG) {
      const rawValue = argv[index + 1];
      const parsedPort = parsePort(rawValue);

      if (parsedPort !== null) {
        portOverride = parsedPort;
        index += 1;
        continue;
      }

      console.warn(
        `[MCP] Ignoring invalid ${MCP_PORT_LAUNCH_ARG} value: ${String(rawValue ?? "<missing>")}`
      );
      continue;
    }

    if (!arg.startsWith(`${MCP_PORT_LAUNCH_ARG}=`)) {
      continue;
    }

    const rawValue = arg.slice(MCP_PORT_LAUNCH_ARG.length + 1);
    const parsedPort = parsePort(rawValue);

    if (parsedPort !== null) {
      portOverride = parsedPort;
      continue;
    }

    console.warn(
      `[MCP] Ignoring invalid ${MCP_PORT_LAUNCH_ARG} value: ${rawValue || "<missing>"}`
    );
  }

  return portOverride;
}

function resolveEndpoint(): string {
  const endpoint = Settings.get("mcp_endpoint");
  return typeof endpoint === "string" && endpoint.trim()
    ? endpoint
    : DEFAULT_MCP_ENDPOINT;
}

export function resolveMcpServerConfig(): ResolvedMcpServerConfig {
  // Blockbench exposes launch arguments on Blockbench.argv, not process.argv
  // @ts-ignore - Blockbench is a global in the plugin environment
  const argv: string[] = Array.isArray(Blockbench.argv) ? Blockbench.argv : (Array.isArray(process.argv) ? process.argv : []);
  const launchArgumentPort = resolveLaunchArgumentPort(argv);

  if (launchArgumentPort !== null) {
    return {
      endpoint: resolveEndpoint(),
      port: launchArgumentPort,
      portSource: "launch-arg",
    };
  }

  const settingsPort = parsePort(Settings.get("mcp_port"));
  if (settingsPort !== null) {
    return {
      endpoint: resolveEndpoint(),
      port: settingsPort,
      portSource: "settings",
    };
  }

  return {
    endpoint: resolveEndpoint(),
    port: DEFAULT_MCP_PORT,
    portSource: "default",
  };
}
