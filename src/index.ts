#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as z from 'zod/v4';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string };
const PACKAGE_VERSION = packageJson.version;

export const SearchToolSchema = z.object({
  query: z.string().describe('The search query string'),
  language: z.string().optional().describe('Language code for search results (e.g., "en-US", "fr", "de")'),
  categories: z.array(z.string()).optional().describe('Categories to search in (e.g., ["general", "images", "news"])'),
  time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time range for results'),
  safesearch: z.number().int().min(0).max(2).optional().describe('Safe search level (0: off, 1: moderate, 2: strict)'),
  format: z.enum(['json', 'html']).optional().describe('Result format (default: "json")'),
  max_results: z.number().int().positive().optional().describe('Maximum number of results to return')
});

type SearchArgs = z.infer<typeof SearchToolSchema>;

interface SearxngResponse {
  results?: unknown[];
  [key: string]: unknown;
}

interface CacheEntry {
  timestamp: number;
  data: SearxngResponse;
}

type McpToolResult = CallToolResult;

const configuredSearxngUrl = process.env.SEARXNG_INSTANCE_URL;
const DEBUG_MODE = process.env.SEARXNG_BRIDGE_DEBUG === 'true';

// Logging utility for redacting sensitive information
export const redactLog = (message: string, ...args: unknown[]) => {
  if (!DEBUG_MODE) return;

  const redactedMessage = message
    .replace(/(Authorization: Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(mcp-session-id:\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(SEARXNG_INSTANCE_URL=)[^\s]+/g, '$1[REDACTED]');

  console.log(redactedMessage, ...args);
};

// Redact sensitive credentials embedded in instance URLs
export const redactUrl = (url: string | undefined) => {
  if (url) {
    return url.replace(/(https?:\/\/)[^/@]*@/, '$1[REDACTED]@');
  }
  return url || '';
};

if (!configuredSearxngUrl) {
  console.error('[SearxNG Bridge] ERROR: SEARXNG_INSTANCE_URL environment variable is not set.');
  process.exit(1);
}

const SEARXNG_URL: string = configuredSearxngUrl;
console.log(`[SearxNG Bridge] Using SearxNG instance URL: ${redactUrl(SEARXNG_URL)}`);

export interface SearxngBridgeServerOptions {
  axiosInstance?: AxiosInstance;
  packageVersion?: string;
}

export class SearxngBridgeServer {
  private readonly server: McpServer;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;
  private readonly packageVersion: string;

  constructor(options: SearxngBridgeServerOptions = {}) {
    this.packageVersion = options.packageVersion ?? PACKAGE_VERSION;
    this.server = new McpServer(
      {
        name: 'searxng-bridge',
        version: options.packageVersion ?? PACKAGE_VERSION,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = options.axiosInstance ?? axios.create({
      baseURL: SEARXNG_URL,
      timeout: 30000, // 30s timeout for slower instances
      headers: {
        // Add a common browser User-Agent to potentially avoid bot detection
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      }
    });

    this.registerTools();
  }

  private async validateSearxngConnection(): Promise<void> {
    console.log(`[SearxNG Bridge] Validating connection to ${SEARXNG_URL}...`);

    try {
      const response = await this.axiosInstance.get<SearxngResponse>('/search', {
        params: { q: 'connection_test', format: 'json' },
        timeout: 10000 // 10s for validation
      });

      if (response.status === 200 && response.data) {
        console.log('[SearxNG Bridge] ✅ Successfully connected to SearXNG instance');
      } else {
        console.warn(`[SearxNG Bridge] ⚠️  SearXNG returned status: ${response.status}`);
      }
    } catch (error) {
      console.error(`[SearxNG Bridge] ❌ Failed to connect to SearXNG instance at ${SEARXNG_URL}`);
      this.logConnectionFailure(error);
      console.error('[SearxNG Bridge] Server will continue running but searches may fail');
    }
  }

  private logConnectionFailure(error: unknown): void {
    if (!axios.isAxiosError(error)) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[SearxNG Bridge] Network error: ${message}`);
      return;
    }

    const status = error.response?.status;
    if (error.code === 'ECONNREFUSED') {
      console.error(`[SearxNG Bridge] Connection refused - check if SearXNG is running at ${SEARXNG_URL}`);
    } else if (error.code === 'ETIMEDOUT') {
      console.error('[SearxNG Bridge] Connection timeout - SearXNG may be slow or unreachable');
    } else if (status === 404) {
      console.error('[SearxNG Bridge] Search endpoint not found - verify SearXNG configuration');
    } else {
      console.error(`[SearxNG Bridge] HTTP Error: ${status || error.message}`);
    }
  }

  private async performHealthCheck(): Promise<McpToolResult> {
    const startTime = Date.now();
    let searxngStatus = 'unknown';
    let responseTime = 0;

    try {
      const response = await this.axiosInstance.get<SearxngResponse>('/search', {
        params: { q: 'health_check', format: 'json' },
        timeout: 5000
      });
      responseTime = Date.now() - startTime;
      searxngStatus = response.status === 200 ? 'healthy' : 'unhealthy';
    } catch (error) {
      responseTime = Date.now() - startTime;
      searxngStatus = 'error';
      this.logHealthCheckFailure(error);
    }

    const healthStatus = {
      status: searxngStatus === 'healthy' ? 'healthy' : 'degraded',
      searxng_instance: SEARXNG_URL,
      searxng_status: searxngStatus,
      response_time_ms: responseTime,
      cache_size: this.cache.size,
      debug_mode: DEBUG_MODE,
      version: this.packageVersion,
      timestamp: new Date().toISOString()
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(healthStatus, null, 2) }],
      isError: searxngStatus !== 'healthy' ? true : undefined,
    };
  }

  private logHealthCheckFailure(error: unknown): void {
    if (axios.isAxiosError(error)) {
      console.error(`[SearxNG Bridge] Health check failed: ${error.code || error.message}`);
      return;
    }
    console.error('[SearxNG Bridge] Health check failed:', error);
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }

  private setupProcessHandlers(): void {
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
    });

    const interval = setInterval(() => this.cleanCache(), 60 * 1000);
    interval.unref();
  }

  private registerTools(): void {
    this.server.registerTool(
      'search',
      {
        description: 'Perform a search using the configured SearxNG instance',
        inputSchema: SearchToolSchema
      },
      async (args) => this.performSearch(args)
    );

    this.server.registerTool(
      'health_check',
      {
        description: 'Check the health and connectivity status of the SearxNG bridge',
        inputSchema: z.object({})
      },
      async () => this.performHealthCheck()
    );
  }

  private async performSearch(args: SearchArgs): Promise<McpToolResult> {
    const searchParams = this.buildSearchParams(args);
    const cacheKey = `search:${JSON.stringify(searchParams)}`;
    const cachedResult = this.getCachedResult(cacheKey, args.max_results);

    if (cachedResult) {
      return { content: [{ type: 'text', text: JSON.stringify(cachedResult, null, 2) }] };
    }

    try {
      const results = await this.performSearchWithRetry(searchParams);
      this.cache.set(cacheKey, { timestamp: Date.now(), data: results });
      const limitedResults = this.applyMaxResults(results, args.max_results);
      return { content: [{ type: 'text', text: JSON.stringify(limitedResults, null, 2) }] };
    } catch (error) {
      const message = this.createSearchFailureMessage(error);
      console.error(`[SearxNG Bridge] ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  private buildSearchParams(args: SearchArgs): Record<string, unknown> {
    const searchParams: Record<string, unknown> = {
      q: args.query,
      format: args.format || 'json'
    };

    if (args.language) searchParams.language = args.language;
    if (args.categories) searchParams.categories = args.categories.join(',');
    if (args.time_range) searchParams.time_range = args.time_range;
    if (args.safesearch !== undefined) searchParams.safesearch = args.safesearch;
    return searchParams;
  }

  private getCachedResult(cacheKey: string, maxResults?: number): SearxngResponse | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry || Date.now() - entry.timestamp >= this.CACHE_TTL) return undefined;
    return this.applyMaxResults(entry.data, maxResults);
  }

  private applyMaxResults(result: SearxngResponse, maxResults?: number): SearxngResponse {
    if (!maxResults || !Array.isArray(result.results)) return result;
    return { ...result, results: result.results.slice(0, maxResults) };
  }

  private async performSearchWithRetry(searchParams: Record<string, unknown>): Promise<SearxngResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const response = await this.axiosInstance.get<SearxngResponse>('/search', {
          params: searchParams
        });
        return response.data;
      } catch (error) {
        lastError = error;
        if (attempt < this.MAX_RETRIES) {
          await this.sleep(this.RETRY_DELAY * attempt);
        }
      }
    }

    throw lastError ?? new Error('SearXNG search failed');
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private createSearchFailureMessage(error: unknown): string {
    const retryMessage = `Failed to fetch search results from SearxNG instance at ${SEARXNG_URL} after ${this.MAX_RETRIES} attempts.`;

    if (!axios.isAxiosError(error)) {
      if (error instanceof Error) {
        return `Unexpected error while contacting ${SEARXNG_URL}: ${error.message}`;
      }
      return retryMessage;
    }

    const codeMessages = new Map<string, string>([
      ['ECONNREFUSED', `Connection refused to SearXNG at ${SEARXNG_URL} - check if the instance is running and accessible`],
      ['ETIMEDOUT', `Connection timeout to SearXNG at ${SEARXNG_URL} - the instance may be slow or unreachable`],
      ['ENOTFOUND', `SearXNG instance not found at ${SEARXNG_URL} - check the URL configuration`]
    ]);

    if (error.code && codeMessages.has(error.code)) {
      return codeMessages.get(error.code)!;
    }

    const status = error.response?.status;
    if (status === 404) {
      return `SearXNG search endpoint not found at ${SEARXNG_URL}/search - verify instance configuration`;
    }
    if (status === 503) {
      return `SearXNG service unavailable (503) - the instance may be overloaded or down`;
    }
    if (status) {
      return `SearXNG request error (${SEARXNG_URL}): HTTP ${status} - ${error.response?.statusText}`;
    }
    return `SearXNG request error (${SEARXNG_URL}): ${error.message}`;
  }

  private getTransportMode(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): string {
    const inlineTransport = argv.find((argument) => argument.startsWith('--transport='));

    if (inlineTransport) {
      return inlineTransport.split('=')[1] || 'stdio';
    }

    const transportFlagIndex = argv.indexOf('--transport');
    if (transportFlagIndex !== -1 && transportFlagIndex + 1 < argv.length) {
      return argv[transportFlagIndex + 1];
    }

    if (env.TRANSPORT) {
      return env.TRANSPORT;
    }

    return 'stdio';
  }

  async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    this.setupProcessHandlers();
    await this.validateSearxngConnection();
    const transport = this.getTransportMode(argv);

    if (transport === 'http') {
      this.startHttpServer();
      return;
    }

    await this.runStdioServer();
  }

  private async runStdioServer(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`SearxNG Bridge MCP server v${this.packageVersion} running on stdio`);

    if (DEBUG_MODE) {
      console.error('[SearxNG Bridge] Debug mode enabled');
    }

    process.once('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private startHttpServer(): void {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number.parseInt(process.env.PORT || '3002', 10);
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const app = this.createHttpApp(transports, host, port);
    const httpServer = app.listen(port, host, () => {
      console.error(`SearxNG Bridge MCP server v${this.packageVersion} running on http://${host}:${port}`);
      if (DEBUG_MODE) console.error('[SearxNG Bridge] Debug mode enabled');
      if (process.env.MCP_HTTP_BEARER) console.error('[SearxNG Bridge] Bearer authentication enabled');
    });

    this.registerHttpShutdown(httpServer, transports);
  }

  private createHttpApp(
    transports: Map<string, StreamableHTTPServerTransport> = new Map(),
    host = process.env.HOST || '127.0.0.1',
    port = Number.parseInt(process.env.PORT || '3002', 10)
  ): Express {
    const app: Express = express();
    const corsOrigin = this.getCorsOrigin();

    app.disable('x-powered-by');
    app.set('json escape', true);
    app.use(express.json());
    app.use(this.createHttpLoggingMiddleware());
    app.use(this.createBearerAuthMiddleware());
    app.use(cors(this.createCorsOptions(corsOrigin)));

    app.post('/mcp', this.createMcpRateLimiter(), this.createMcpPostHandler(transports, host, port));
    app.get('/mcp', this.createSessionRequestHandler(transports));
    app.delete('/mcp', this.createSessionRequestHandler(transports));
    app.get('/healthz', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', version: this.packageVersion });
    });

    return app;
  }

  private createHttpLoggingMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      redactLog(`[SearxNG Bridge] Incoming request: ${req.method} ${req.path}`);
      redactLog(`[SearxNG Bridge] Headers: ${JSON.stringify(req.headers, null, 2)}`);
      next();
    };
  }

  private createBearerAuthMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const isProtectedPath = req.path.startsWith('/mcp') || req.path.startsWith('/healthz');
      const isProtectedMethod = ['POST', 'GET', 'DELETE'].includes(req.method);

      if (!isProtectedPath || !isProtectedMethod || !process.env.MCP_HTTP_BEARER) {
        next();
        return;
      }

      const authorization = req.headers.authorization;
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

      if (!token || token !== process.env.MCP_HTTP_BEARER) {
        redactLog('[SearxNG Bridge] Unauthorized access attempt - missing or invalid Authorization header');
        res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
        return;
      }

      next();
    };
  }

  private getCorsOrigin(): string | string[] {
    const configuredOrigin = process.env.CORS_ORIGIN;

    if (configuredOrigin) {
      const origins = configuredOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
      return origins.length === 1 ? origins[0] : origins;
    }

    if (process.env.NODE_ENV === 'production') {
      return '*';
    }

    return ['http://localhost:3002', 'http://127.0.0.1:3002'];
  }

  private isOriginAllowed(origin: string, allowedOrigins: string | string[]): boolean {
    if (allowedOrigins === '*') return true;
    if (Array.isArray(allowedOrigins)) return allowedOrigins.includes(origin);
    return allowedOrigins === origin;
  }

  private createCorsOptions(corsOrigin: string | string[]) {
    return {
      origin: (origin: string | undefined, callback: (error: Error | null, origin?: false | string) => void) => {
        if (!origin) {
          callback(null, false);
          return;
        }

        if (!this.isOriginAllowed(origin, corsOrigin)) {
          redactLog(`[SearxNG Bridge] CORS blocked origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
          return;
        }

        callback(null, origin);
      },
      credentials: corsOrigin !== '*',
      exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
    };
  }

  private createMcpRateLimiter() {
    return rateLimit({
      windowMs: 60 * 1000, // 60 seconds
      limit: 100, // 100 requests per windowMs
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.'
      },
      skipSuccessfulRequests: false
    });
  }

  private createMcpPostHandler(
    transports: Map<string, StreamableHTTPServerTransport>,
    host: string,
    port: number
  ) {
    return async (req: Request, res: Response) => {
      redactLog(`[SearxNG Bridge] POST /mcp received: ${JSON.stringify(req.body)}`);
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existingTransport = sessionId ? transports.get(sessionId) : undefined;

      if (existingTransport) {
        await existingTransport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        await this.connectHttpTransport(transports, host, port, req, res);
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      });
    };
  }

  private async connectHttpTransport(
    transports: Map<string, StreamableHTTPServerTransport>,
    host: string,
    port: number,
    req: Request,
    res: Response
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (!sessionId) return;
      transports.delete(sessionId);
    };

    await this.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  private createSessionRequestHandler(transports: Map<string, StreamableHTTPServerTransport>) {
    return async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? transports.get(sessionId) : undefined;

      if (!sessionId || !transport) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      await transport.handleRequest(req, res);
    };
  }

  private registerHttpShutdown(
    httpServer: ReturnType<Express['listen']>,
    transports: Map<string, StreamableHTTPServerTransport>
  ): void {
    let shuttingDown = false;

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error('[SearxNG Bridge] Shutting down...');

      for (const [sessionId, transport] of transports.entries()) {
        try {
          await transport.close();
        } catch (error) {
          console.error(`[SearxNG Bridge] Error closing transport ${sessionId}:`, error);
        }
      }

      await this.server.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      console.error('[SearxNG Bridge] HTTP server closed');
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }
}

const entryArgument = process.argv[1];
const isDirectExecution = Boolean(entryArgument) && import.meta.url === pathToFileURL(entryArgument).href;

if (isDirectExecution) {
  try {
    const server = new SearxngBridgeServer();
    await server.run();
  } catch (error) {
    console.error('[SearxNG Bridge] Fatal error:', error);
    process.exit(1);
  }
}
