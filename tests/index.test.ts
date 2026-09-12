import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

process.env.SEARXNG_INSTANCE_URL = 'http://searxng.test';
process.env.SEARXNG_BRIDGE_DEBUG = 'true';

type IndexModule = typeof import('../src/index.js');
type SearchArgs = import('../src/index.js')['SearchToolSchema'] extends never ? never : {
  query: string;
  language?: string;
  categories?: string[];
  time_range?: 'day' | 'week' | 'month' | 'year';
  safesearch?: number;
  format?: 'json' | 'html';
  max_results?: number;
};

type ServerFixture = {
  validateSearxngConnection: () => Promise<void>;
  performHealthCheck: () => Promise<{ isError?: boolean }>;
  performSearch: (args: SearchArgs) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  cleanCache: () => void;
  getTransportMode: (argv?: string[], env?: NodeJS.ProcessEnv) => string;
  run: (argv?: string[]) => Promise<void>;
  createHttpApp: (
    transports?: Map<string, StreamableHTTPServerTransport>,
    host?: string,
    port?: number
  ) => any;
  getCorsOrigin: () => string | string[];
  isOriginAllowed: (origin: string, allowed: string | string[]) => boolean;
  createCorsOptions: (allowed: string | string[]) => {
    origin: (origin: string | undefined, callback: (error: Error | null, origin?: false | string) => void) => void;
    credentials: boolean;
  };
  createSearchFailureMessage: (error: unknown) => string;
  registerHttpShutdown: (
    httpServer: { close: (callback?: () => void) => unknown },
    transports: Map<string, { close: () => Promise<void> }>
  ) => void;
  [key: string]: unknown;
};

let bridge: IndexModule;

beforeAll(async () => {
  bridge = await import('../src/index.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const makeServer = (getResponse = vi.fn()) => {
  const axiosInstance = { get: getResponse } as unknown as AxiosInstance;
  const server = new bridge.SearxngBridgeServer({ axiosInstance, packageVersion: 'test-version' });
  return { server: server as unknown as ServerFixture, get: getResponse };
};

const axiosErrorResponse = (status: number, statusText = 'Error'): AxiosResponse => ({
  data: {},
  status,
  statusText,
  headers: {},
  config: { headers: {} } as AxiosResponse['config']
});

const axiosError = (code?: string, status?: number, statusText = 'Error') =>
  new AxiosError('request failed', code, { headers: {} } as AxiosError['config'], {}, status === undefined ? undefined : axiosErrorResponse(status, statusText));

describe('SearXNG bridge configuration helpers', () => {
  it('redacts credentials and bearer tokens', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    bridge.redactLog('Authorization: Bearer secret mcp-session-id: session SEARXNG_INSTANCE_URL=top-secret');
    expect(logSpy).toHaveBeenCalledWith(
      'Authorization: Bearer [REDACTED] mcp-session-id: [REDACTED] SEARXNG_INSTANCE_URL=[REDACTED]'
    );
    expect(bridge.redactUrl('http://user:password@searxng.test')).toBe('http://[REDACTED]@searxng.test');
    expect(bridge.redactUrl(undefined)).toBe('');
  });

  it('defines a validated search schema', () => {
    expect(bridge.SearchToolSchema.safeParse({ query: 'mcp' }).success).toBe(true);
    expect(bridge.SearchToolSchema.safeParse({}).success).toBe(false);
    expect(bridge.SearchToolSchema.safeParse({ query: 'mcp', format: 'xml' }).success).toBe(false);
  });
});

describe('MCP tools', () => {
  it('registers searchable and health tools over an in-memory MCP transport', async () => {
    const { server, get } = makeServer();
    get.mockResolvedValue({ status: 200, data: { results: [] } });

    const mcpServer = (server as { server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer }).server;
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search', 'health_check']);

    const result = await client.callTool({ name: 'health_check', arguments: {} });
    expect(result.isError).toBeFalsy();

    await client.close();
    await mcpServer.close();
  });

  it('searches, filters results, and reuses cached results', async () => {
    const { server, get } = makeServer();
    get.mockResolvedValue({
      status: 200,
      data: { query: 'mcp', results: [{ title: 'first' }, { title: 'second' }], number_of_results: 2 }
    });

    const first = await server.performSearch({
      query: 'mcp',
      language: 'en-US',
      categories: ['general', 'news'],
      time_range: 'week',
      safesearch: 1,
      format: 'json',
      max_results: 1
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/search', {
      params: {
        q: 'mcp',
        format: 'json',
        language: 'en-US',
        categories: 'general,news',
        time_range: 'week',
        safesearch: 1
      }
    });
    expect(JSON.parse(first.content[0].text).results).toHaveLength(1);

    const cached = await server.performSearch({
      query: 'mcp',
      language: 'en-US',
      categories: ['general', 'news'],
      time_range: 'week',
      safesearch: 1,
      format: 'json',
      max_results: 2
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cached.content[0].text).results).toHaveLength(2);
  });

  it('does not use stale cache entries', () => {
    const { server } = makeServer();
    const cache = (server as { cache: Map<string, { timestamp: number; data: unknown }> }).cache;
    cache.set('search:{}', { timestamp: Date.now() - 6 * 60 * 1000, data: { results: [] } });

    server.cleanCache();
    expect(cache.has('search:{}')).toBe(false);
  });

  it('retries failed searches and returns a structured tool error', async () => {
    const { server, get } = makeServer();
    get.mockRejectedValue(axiosError('ECONNREFUSED'));
    vi.spyOn(server, 'sleep').mockResolvedValue(undefined);

    const result = await server.performSearch({ query: 'failure' });

    expect(get).toHaveBeenCalledTimes(3);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused to SearXNG');
  });

  it('formats all expected search failure modes', () => {
    const { server } = makeServer();
    const createMessage = server.createSearchFailureMessage.bind(server);

    expect(createMessage(axiosError('ECONNREFUSED'))).toContain('Connection refused');
    expect(createMessage(axiosError('ETIMEDOUT'))).toContain('Connection timeout');
    expect(createMessage(axiosError('ENOTFOUND'))).toContain('instance not found');
    expect(createMessage(axiosError(undefined, 404))).toContain('search endpoint not found');
    expect(createMessage(axiosError(undefined, 503))).toContain('service unavailable');
    expect(createMessage(axiosError(undefined, 500, 'Broken'))).toContain('HTTP 500 - Broken');
    expect(createMessage(axiosError())).toContain('SearXNG request error');
    expect(createMessage(new Error('unexpected'))).toContain('Unexpected error');
    expect(createMessage('bad value')).toContain('after 3 attempts');
  });

  it('reports healthy, unhealthy, and failed health checks', async () => {
    const healthy = makeServer();
    healthy.get.mockResolvedValue({ status: 200, data: {} });
    const healthyResult = await healthy.server.performHealthCheck();
    expect(healthyResult.isError).toBeFalsy();

    const unhealthy = makeServer();
    unhealthy.get.mockResolvedValue({ status: 503, data: {} });
    const unhealthyResult = await unhealthy.server.performHealthCheck();
    expect(unhealthyResult.isError).toBe(true);

    const failed = makeServer();
    failed.get.mockRejectedValue(new Error('offline'));
    const failedResult = await failed.server.performHealthCheck();
    expect(failedResult.isError).toBe(true);
    expect(JSON.parse(failedResult.content[0].text).searxng_status).toBe('error');
  });

  it('logs validation failures for axios and unknown errors', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const successSpy = vi.spyOn(console, 'log');
    const success = makeServer();
    success.get.mockResolvedValue({ status: 200, data: {} });
    await success.server.validateSearxngConnection();

    const warning = makeServer();
    warning.get.mockResolvedValue({ status: 204, data: undefined });
    await warning.server.validateSearxngConnection();

    const refused = makeServer();
    refused.get.mockRejectedValue(axiosError('ECONNREFUSED'));
    await refused.server.validateSearxngConnection();

    const timedOut = makeServer();
    timedOut.get.mockRejectedValue(axiosError('ETIMEDOUT'));
    await timedOut.server.validateSearxngConnection();

    const notFound = makeServer();
    notFound.get.mockRejectedValue(axiosError(undefined, 404));
    await notFound.server.validateSearxngConnection();

    const generic = makeServer();
    generic.get.mockRejectedValue(axiosError('ERR_NETWORK', 500));
    await generic.server.validateSearxngConnection();

    const ordinaryError = makeServer();
    ordinaryError.get.mockRejectedValue(new Error('dns failed'));
    await ordinaryError.server.validateSearxngConnection();

    const unknownError = makeServer();
    unknownError.get.mockRejectedValue('oops');
    await unknownError.server.validateSearxngConnection();

    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('Successfully connected'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Network error: dns failed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Network error: Unknown error'));
  });
});

describe('transport selection', () => {
  it('supports inline flags, separate flags, environment variables, and the default', () => {
    const { server } = makeServer();

    expect(server.getTransportMode(['--transport=http'])).toBe('http');
    expect(server.getTransportMode(['--transport'])).toBe('stdio');
    expect(server.getTransportMode(['--transport', 'http'])).toBe('http');
    expect(server.getTransportMode([], { TRANSPORT: 'http' })).toBe('http');
    expect(server.getTransportMode([])).toBe('stdio');
  });

  it('routes run to HTTP and stdio startup', async () => {
    const { server, get } = makeServer();
    get.mockResolvedValue({ status: 200, data: {} });
    const processOn = vi.spyOn(process, 'on').mockReturnValue(process);
    const processOnce = vi.spyOn(process, 'once').mockReturnValue(process);
    const startHttpServer = vi.fn();
    const runStdioServer = vi.fn().mockResolvedValue(undefined);
    server.startHttpServer = startHttpServer;
    server.runStdioServer = runStdioServer;

    await server.run(['--transport', 'http']);
    await server.run(['--transport', 'stdio']);

    expect(processOn).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(runStdioServer).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP server', () => {
  it('exposes health and CORS headers without x-powered-by', async () => {
    vi.stubEnv('CORS_ORIGIN', 'http://localhost:3002');
    const { server } = makeServer();
    const app = server.createHttpApp(new Map(), '127.0.0.1', 3002);
    const response = await request(app)
      .get('/healthz')
      .set('Origin', 'http://localhost:3002');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version: 'test-version' });
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3002');
  });

  it('protects endpoints when a bearer token is configured', async () => {
    vi.stubEnv('MCP_HTTP_BEARER', 'correct-token');
    const { server } = makeServer();
    const app = server.createHttpApp(new Map(), '127.0.0.1', 3002);

    const missing = await request(app).get('/healthz');
    const invalid = await request(app).get('/healthz').set('Authorization', 'Bearer wrong-token');
    const valid = await request(app).get('/healthz').set('Authorization', 'Bearer correct-token');

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
  });

  it('rejects MCP requests without a valid session or initialize request', async () => {
    const { server } = makeServer();
    const app = server.createHttpApp(new Map(), '127.0.0.1', 3002);

    const response = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('No valid session ID');
  });

  it('routes existing MCP sessions to their transport', async () => {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const handleRequest = vi.fn(async (_request: unknown, response: { status: (code: number) => { end: () => void } }) => {
      response.status(200).end();
    });
    transports.set('known-session', { handleRequest } as unknown as StreamableHTTPServerTransport);
    const { server } = makeServer();
    const app = server.createHttpApp(transports, '127.0.0.1', 3002);

    await request(app)
      .post('/mcp')
      .set('mcp-session-id', 'known-session')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await request(app)
      .get('/mcp')
      .set('mcp-session-id', 'known-session');
    await request(app)
      .delete('/mcp')
      .set('mcp-session-id', 'known-session');

    expect(handleRequest).toHaveBeenCalledTimes(3);
  });

  it('returns invalid-session errors for unknown GET and DELETE requests', async () => {
    const { server } = makeServer();
    const app = server.createHttpApp(new Map(), '127.0.0.1', 3002);

    const getResponse = await request(app).get('/mcp').set('mcp-session-id', 'missing');
    const deleteResponse = await request(app).delete('/mcp').set('mcp-session-id', 'missing');

    expect(getResponse.status).toBe(400);
    expect(deleteResponse.status).toBe(400);
  });

  it('initializes, stores, and closes a streamable HTTP MCP session', async () => {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const { server } = makeServer();
    const app = server.createHttpApp(transports, '127.0.0.1', 3002);

    const response = await request(app)
      .post('/mcp')
      .set('Host', '127.0.0.1:3002')
      .set('Accept', 'application/json, text/event-stream')
      .set('Origin', 'http://localhost:3002')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest-client', version: '1.0.0' }
        }
      });

    const sessionId = response.headers['mcp-session-id'];
    expect(response.status).toBe(200);
    expect(sessionId).toBeDefined();
    expect(transports.has(sessionId)).toBe(true);

    const transport = transports.get(sessionId)!;
    await transport.close();
    expect(transports.has(sessionId)).toBe(false);
  });

  it('resolves CORS origins from configuration, production, and defaults', () => {
    const { server } = makeServer();

    vi.stubEnv('CORS_ORIGIN', ' https://one.test , https://two.test ,');
    expect(server.getCorsOrigin()).toEqual(['https://one.test', 'https://two.test']);
    vi.stubEnv('CORS_ORIGIN', 'https://single.test');
    expect(server.getCorsOrigin()).toBe('https://single.test');
    vi.stubEnv('CORS_ORIGIN', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(server.getCorsOrigin()).toBe('*');
    vi.stubEnv('NODE_ENV', 'test');
    expect(server.getCorsOrigin()).toEqual(['http://localhost:3002', 'http://127.0.0.1:3002']);
  });

  it('validates CORS origins and invokes the CORS callback', () => {
    const { server } = makeServer();
    expect(server.isOriginAllowed('https://one.test', '*')).toBe(true);
    expect(server.isOriginAllowed('https://one.test', ['https://one.test'])).toBe(true);
    expect(server.isOriginAllowed('https://one.test', 'https://one.test')).toBe(true);
    expect(server.isOriginAllowed('https://one.test', 'https://two.test')).toBe(false);

    const options = server.createCorsOptions('https://one.test');
    const noOrigin = vi.fn();
    options.origin(undefined, noOrigin);

    const blocked = vi.fn();
    options.origin('https://blocked.test', blocked);

    const allowed = vi.fn();
    options.origin('https://one.test', allowed);

    expect(noOrigin).toHaveBeenCalledWith(null, false);
    expect(blocked).toHaveBeenCalledWith(expect.any(Error));
    expect(allowed).toHaveBeenCalledWith(null, 'https://one.test');
    expect(options.credentials).toBe(true);
  });

  it('closes HTTP sessions and exits during shutdown', async () => {
    const { server } = makeServer();
    const listeners: Record<string, () => void> = {};
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      listeners[event] = listener;
      return process;
    }) as typeof process.once);
    const exitSpy = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const transportClose = vi.fn().mockResolvedValue(undefined);
    const transportFail = vi.fn().mockRejectedValue(new Error('close failed'));
    const transports = new Map([
      ['one', { close: transportClose }],
      ['two', { close: transportFail }]
    ]);
    const mcpClose = vi.fn().mockResolvedValue(undefined);
    (server as { server: { close: () => Promise<void> } }).server.close = mcpClose;
    const httpClose = vi.fn((callback?: () => void) => {
      callback?.();
      return server;
    });

    server.registerHttpShutdown({ close: httpClose }, transports);
    listeners.SIGTERM();

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(transportClose).toHaveBeenCalledTimes(1);
    expect(transportFail).toHaveBeenCalledTimes(1);
    expect(mcpClose).toHaveBeenCalledTimes(1);
    expect(httpClose).toHaveBeenCalledWith(expect.any(Function));
    expect(logSpy.mock.calls.some(([message]) => String(message).includes('Error closing transport two'))).toBe(true);

    onceSpy.mockRestore();
  });
});
