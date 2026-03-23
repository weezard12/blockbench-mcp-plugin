import { version } from "../package.json" assert { type: "json" };

export const VERSION = version;
export const STATUS_STABLE = "stable";
export const STATUS_EXPERIMENTAL = "experimental";
export const DEFAULT_MCP_PORT = 3000;
export const DEFAULT_MCP_ENDPOINT = "/bb-mcp";
export const MCP_PORT_LAUNCH_ARG = "--mcp-port";
