import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Anthropic from "@anthropic-ai/sdk";

export interface PlaywrightMcpClientOptions {
  serverUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export class PlaywrightMcpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private options: PlaywrightMcpClientOptions;
  private connected: boolean = false;
  private cachedTools: McpTool[] = [];

  constructor(options: PlaywrightMcpClientOptions = {}) {
    this.options = {
      serverUrl: options.serverUrl || process.env.PLAYWRIGHT_MCP_URL,
      command: options.command || process.env.PLAYWRIGHT_MCP_COMMAND || "npx",
      args:
        options.args ||
        (process.env.PLAYWRIGHT_MCP_ARGS
          ? JSON.parse(process.env.PLAYWRIGHT_MCP_ARGS)
          : ["playwright-mcp", "--headless"]),
      env: {
        ...process.env,
        ...(options.env || {}),
      } as Record<string, string>,
      clientName: options.clientName || "utwat-job-autofill-agent",
      clientVersion: options.clientVersion || "1.0.0",
    };
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    const { serverUrl, command, args, env, clientName, clientVersion } = this.options;

    if (serverUrl) {
      console.log(`[MCP] Connecting to SSE server at: ${serverUrl}`);
      this.transport = new SSEClientTransport(new URL(serverUrl));
    } else {
      console.log(`[MCP] Connecting to stdio server: ${command} ${args?.join(" ")}`);
      this.transport = new StdioClientTransport({
        command: command!,
        args: args || [],
        env: env,
      });
    }

    this.client = new Client(
      {
        name: clientName!,
        version: clientVersion!,
      },
      {
        capabilities: {},
      }
    );

    await this.client.connect(this.transport);
    this.connected = true;

    // Fetch and cache tools
    await this.refreshTools();
    console.log(`[MCP] Successfully connected. Discovered ${this.cachedTools.length} tool(s).`);
  }

  public async refreshTools(): Promise<McpTool[]> {
    if (!this.client) {
      throw new Error("MCP client is not connected");
    }

    const result = await this.client.listTools();
    this.cachedTools = result.tools || [];
    return this.cachedTools;
  }

  /**
   * Transforms MCP tool definitions into Anthropic's Tool format for client.messages.create()
   */
  public async getAnthropicTools(): Promise<Anthropic.Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const tools = this.cachedTools.length > 0 ? this.cachedTools : await this.refreshTools();

    return tools.map((tool) => {
      const inputSchema = tool.inputSchema || {
        type: "object",
        properties: {},
      };

      return {
        name: tool.name,
        description: tool.description || `Tool for ${tool.name}`,
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      };
    });
  }

  /**
   * Executes a tool call against the MCP server and formats the result string for Claude
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    if (!this.client || !this.connected) {
      throw new Error("MCP client is not connected");
    }

    try {
      console.log(`[MCP] Calling tool: ${name} with args:`, JSON.stringify(args, null, 2));

      const response = (await this.client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;

      const isError = Boolean(response.isError);

      if (!response.content || response.content.length === 0) {
        return {
          content: "Tool executed successfully with no output.",
          isError,
        };
      }

      // Collect all content parts
      const parts: string[] = [];
      for (const item of response.content) {
        if (item.type === "text") {
          parts.push(item.text);
        } else if (item.type === "image") {
          parts.push(`[Image content: mimeType=${item.mimeType}, data_length=${item.data?.length || 0}]`);
        } else if (item.type === "resource") {
          parts.push(`[Resource: ${JSON.stringify(item.resource)}]`);
        } else {
          parts.push(JSON.stringify(item));
        }
      }

      return {
        content: parts.join("\n"),
        isError,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MCP] Error executing tool ${name}:`, errorMessage);
      return {
        content: `Error executing tool "${name}": ${errorMessage}`,
        isError: true,
      };
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      if (this.client) {
        await this.client.close();
      }
      if (this.transport) {
        await this.transport.close();
      }
    } catch (err) {
      console.warn("[MCP] Notice during disconnect:", err);
    } finally {
      this.connected = false;
      this.client = null;
      this.transport = null;
      console.log("[MCP] Disconnected from server.");
    }
  }
}
