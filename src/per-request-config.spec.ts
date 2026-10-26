import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureApiSdk,
  createApiClient,
  getOrganizationSupportSummary,
  sdkFetch,
  sdkFetchBlob,
} from './index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return queue.shift() ?? jsonResponse({ success: true, data: null });
  });
}

function asFetch(stub: ReturnType<typeof stubFetch>): typeof fetch {
  return stub as unknown as typeof fetch;
}

function authorizationOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit;
  return (init.headers as Record<string, string>).Authorization;
}

describe('per-request configuration of the SDK mutator', () => {
  beforeEach(() => {
    configureApiSdk({
      baseUrl: 'http://g',
      getAccessToken: () => 'global',
      defaultHeaders: undefined,
      fetchImpl: undefined,
      onUnauthorized: undefined,
      onSuspended: undefined,
    });
  });

  it('uses apiConfig token instead of the global one', async () => {
    const globalFetch = stubFetch();
    configureApiSdk({ fetchImpl: asFetch(globalFetch) });
    const fetchImpl = stubFetch();
    const client = createApiClient({
      baseUrl: 'http://r',
      getAccessToken: () => 'req',
      fetchImpl: asFetch(fetchImpl),
    });

    await sdkFetch('/api/x', client.init());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://r/api/x');
    expect(authorizationOf(fetchImpl.mock.calls[0])).toBe('Bearer req');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('concurrent clients keep their own token', async () => {
    const fetchImpl = stubFetch();
    const asyncToken = (token: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, token === 'a' ? 10 : 0));
      return token;
    };
    const clientA = createApiClient({
      baseUrl: 'http://r',
      getAccessToken: asyncToken('a'),
      fetchImpl: asFetch(fetchImpl),
    });
    const clientB = createApiClient({
      baseUrl: 'http://r',
      getAccessToken: asyncToken('b'),
      fetchImpl: asFetch(fetchImpl),
    });

    await Promise.all([sdkFetch('/api/a', clientA.init()), sdkFetch('/api/b', clientB.init())]);

    const tokenByUrl = new Map(
      fetchImpl.mock.calls.map((call) => [String(call[0]), authorizationOf(call)])
    );
    expect(tokenByUrl.get('http://r/api/a')).toBe('Bearer a');
    expect(tokenByUrl.get('http://r/api/b')).toBe('Bearer b');
  });

  it('apiConfig is not forwarded to fetch', async () => {
    const fetchImpl = stubFetch();
    const client = createApiClient({ baseUrl: 'http://r', fetchImpl: asFetch(fetchImpl) });

    await sdkFetch('/api/x', { ...client.init(), skipSessionAuth: true });

    const forwardedInit = fetchImpl.mock.calls[0][1] as Record<string, unknown>;
    expect(forwardedInit).not.toHaveProperty('apiConfig');
    expect(forwardedInit).not.toHaveProperty('skipSessionAuth');
  });

  it('init merges extra RequestInit with the config', () => {
    const config = { baseUrl: 'http://r' };
    const init = createApiClient(config).init({ method: 'POST' });

    expect(init.method).toBe('POST');
    expect(init.apiConfig).toBe(config);
  });

  it('does not send the global Authorization nor default headers when apiConfig has none', async () => {
    configureApiSdk({ defaultHeaders: { 'X-Global': '1' } });
    const fetchImpl = stubFetch();
    const client = createApiClient({ baseUrl: 'http://r', fetchImpl: asFetch(fetchImpl) });

    await sdkFetch('/api/x', client.init());

    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Global']).toBeUndefined();
  });

  describe('without apiConfig the singleton still applies', () => {
    it('uses the global base URL and token', async () => {
      const fetchImpl = stubFetch();
      configureApiSdk({ fetchImpl: asFetch(fetchImpl) });

      await sdkFetch('/api/x');

      expect(fetchImpl.mock.calls[0][0]).toBe('http://g/api/x');
      expect(authorizationOf(fetchImpl.mock.calls[0])).toBe('Bearer global');
    });

    it('retries once after onUnauthorized returns a new token', async () => {
      const fetchImpl = stubFetch(
        jsonResponse({ message: 'expired' }, 401),
        jsonResponse({ success: true, data: { ok: true } })
      );
      let token = 'old';
      const onUnauthorized = vi.fn(async () => {
        token = 'fresh';
        return token;
      });
      configureApiSdk({
        fetchImpl: asFetch(fetchImpl),
        getAccessToken: () => token,
        onUnauthorized,
      });

      const result = await sdkFetch<{ data: unknown }>('/api/x');

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(authorizationOf(fetchImpl.mock.calls[1])).toBe('Bearer fresh');
      expect(result.data).toEqual({ ok: true });
    });

    it('calls onSuspended on a 423 ORGANIZATION_SUSPENDED body', async () => {
      const body = { code: 'ORGANIZATION_SUSPENDED' };
      const fetchImpl = stubFetch(jsonResponse(body, 423));
      const onSuspended = vi.fn();
      configureApiSdk({ fetchImpl: asFetch(fetchImpl), onSuspended });

      await expect(sdkFetch('/api/x')).rejects.toMatchObject({ status: 423 });

      expect(onSuspended).toHaveBeenCalledWith(body);
    });
  });

  describe('apiConfig hooks are scoped to its own requests', () => {
    it('apiConfig.onUnauthorized is used for its own requests', async () => {
      const fetchImpl = stubFetch(
        jsonResponse({ message: 'expired' }, 401),
        jsonResponse({ success: true, data: { ok: true } })
      );
      const globalOnUnauthorized = vi.fn(async () => 'global-fresh');
      configureApiSdk({ onUnauthorized: globalOnUnauthorized });
      let token = 'req-old';
      const requestOnUnauthorized = vi.fn(async () => {
        token = 'req-fresh';
        return token;
      });
      const client = createApiClient({
        baseUrl: 'http://r',
        getAccessToken: () => token,
        fetchImpl: asFetch(fetchImpl),
        onUnauthorized: requestOnUnauthorized,
      });

      await sdkFetch('/api/x', client.init());

      expect(requestOnUnauthorized).toHaveBeenCalledTimes(1);
      expect(globalOnUnauthorized).not.toHaveBeenCalled();
      expect(authorizationOf(fetchImpl.mock.calls[1])).toBe('Bearer req-fresh');
    });

    it('does not fall back to the global onUnauthorized when apiConfig has none', async () => {
      const fetchImpl = stubFetch(jsonResponse({ message: 'expired' }, 401));
      const globalOnUnauthorized = vi.fn(async () => 'global-fresh');
      configureApiSdk({ onUnauthorized: globalOnUnauthorized });
      const client = createApiClient({ baseUrl: 'http://r', fetchImpl: asFetch(fetchImpl) });

      await expect(sdkFetch('/api/x', client.init())).rejects.toMatchObject({ status: 401 });

      expect(globalOnUnauthorized).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('apiConfig.onSuspended is used for its own requests, not the global one', async () => {
      const fetchImpl = stubFetch(jsonResponse({ data: { code: 'ORGANIZATION_SUSPENDED' } }, 423));
      const globalOnSuspended = vi.fn();
      configureApiSdk({ onSuspended: globalOnSuspended });
      const requestOnSuspended = vi.fn();
      const client = createApiClient({
        baseUrl: 'http://r',
        fetchImpl: asFetch(fetchImpl),
        onSuspended: requestOnSuspended,
      });

      await expect(sdkFetch('/api/x', client.init())).rejects.toMatchObject({ status: 423 });

      expect(requestOnSuspended).toHaveBeenCalledTimes(1);
      expect(globalOnSuspended).not.toHaveBeenCalled();
    });
  });

  it('reaches the mutator through a generated SDK function', async () => {
    const fetchImpl = stubFetch();
    const client = createApiClient({
      baseUrl: 'http://r',
      getAccessToken: () => 'req',
      fetchImpl: asFetch(fetchImpl),
    });

    await getOrganizationSupportSummary('org-1', undefined, client.init());

    expect(String(fetchImpl.mock.calls[0][0]).startsWith('http://r/')).toBe(true);
    expect(authorizationOf(fetchImpl.mock.calls[0])).toBe('Bearer req');
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('apiConfig');
  });

  describe('sdkFetchBlob', () => {
    it('uses apiConfig base URL and token and does not forward apiConfig', async () => {
      const fetchImpl = stubFetch(
        new Response('bytes', { status: 200, headers: { 'content-type': 'application/pdf' } })
      );
      const client = createApiClient({
        baseUrl: 'http://r',
        getAccessToken: () => 'req',
        fetchImpl: asFetch(fetchImpl),
      });

      const blob = await sdkFetchBlob('/api/file', client.init());

      expect(await blob.text()).toBe('bytes');
      expect(fetchImpl.mock.calls[0][0]).toBe('http://r/api/file');
      expect(authorizationOf(fetchImpl.mock.calls[0])).toBe('Bearer req');
      expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('apiConfig');
    });
  });
});
