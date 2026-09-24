// Test helpers: mock global fetch against a route table + a test config.

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mock global fetch. routes: 'METHOD path-suffix' -> () => Response.
 *  Records { method, path, body } per call. Returns { calls, restore }. */
export function mockFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const entry = routes[`${method} ${path}`] || routes[`${method} ${path.split('/').slice(-2).join('/')}`];
    if (entry) return entry();
    return new Response(JSON.stringify({ detail: 'no mock for ' + method + ' ' + path }), { status: 404 });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = orig; },
  };
}

export function testCfg(overrides = {}) {
  return {
    siteOrigin: 'https://api.example.com',
    apiPrefix: '/api/v1',
    mailboxCli: 'cloud-mail',
    mailTimeout: 30,
    mailPollInterval: 1,
    probeModel: 'example-small',
    accountsFile: '/tmp/none.jsonl',
    ...overrides,
  };
}
