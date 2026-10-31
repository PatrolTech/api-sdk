import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, getRouteRounds, sdkFetch, updateLocation } from './index';

function clientWithFetch() {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
  const client = createApiClient({ baseUrl: 'http://r', fetchImpl: fetchImpl as typeof fetch });
  return { client, fetchImpl };
}

describe('path parameters cannot reach another endpoint', () => {
  it.each([
    ['x/details', 'http://r/api/locations/x%2Fdetails'],
    ['a?b#c', 'http://r/api/locations/a%3Fb%23c'],
    ['..%2F', 'http://r/api/locations/..%252F'],
    ['tab\there', 'http://r/api/locations/tab%09here'],
    ['loc-1.v2', 'http://r/api/locations/loc-1.v2'],
  ])('encodes %j as one path segment', async (id, url) => {
    const { client, fetchImpl } = clientWithFetch();

    await updateLocation(id, {} as never, client.init());

    expect(fetchImpl.mock.calls[0][0]).toBe(url);
  });

  it('encodes path parameters but leaves the query string alone', async () => {
    const { client, fetchImpl } = clientWithFetch();

    await getRouteRounds('r/1', { page: 2 } as never, client.init());

    expect(fetchImpl.mock.calls[0][0]).toBe('http://r/api/routes/r%2F1/rounds?page=2');
  });

  it.each(['..', '.'])('refuses the dot segment %j before calling fetch', async (id) => {
    const { client, fetchImpl } = clientWithFetch();

    await expect(updateLocation(id, {} as never, client.init())).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    '@evil.example/x',
    '.evil.example/x',
    '//evil.example/x',
    'api/x',
    '',
    '/api/x/../admin',
    '/api/%2e%2E/admin',
    '/api/.%2e/admin',
    '/api/a\\b',
    '/api/a\tb',
    '/api/a\nb',
  ])('refuses the raw path %j in sdkFetch', async (path) => {
    const { client, fetchImpl } = clientWithFetch();

    await expect(sdkFetch(path, client.init())).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('redirects', () => {
  it('passes redirect: error to fetch unless the caller asks otherwise', async () => {
    const { client, fetchImpl } = clientWithFetch();

    await sdkFetch('/api/x', client.init());
    await sdkFetch('/api/x', client.init({ redirect: 'follow' }));

    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(fetchImpl.mock.calls[1][1].redirect).toBe('follow');
  });

  it('a real 307 fails and never reaches the target with the body', async () => {
    const reached: string[] = [];
    const server = createServer((request, response) => {
      reached.push(request.url ?? '');
      response.writeHead(307, { location: '/target' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    try {
      await expect(
        sdkFetch('/api/token', client.init({ method: 'POST', body: 'refresh_token=secret' }))
      ).rejects.toThrow(TypeError);
      expect(reached).toEqual(['/api/token']);
    } finally {
      server.close();
    }
  });
});
