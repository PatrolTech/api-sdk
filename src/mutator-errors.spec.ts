import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, sdkFetch, sdkFetchBlob } from './index';

/** A response that claims to be JSON but whose body is not (a proxy page, a half-written error). */
function brokenJson(status: number, body = '<html>Bad gateway</html>'): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function clientAnswering(response: () => Response) {
  const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
  return createApiClient({ baseUrl: 'http://r', fetchImpl });
}

describe('error path of the SDK mutator with an unparseable JSON body', () => {
  it('sdkFetch throws ApiError with the HTTP status and the raw text as data, not SyntaxError', async () => {
    const client = clientAnswering(() => brokenJson(502));

    const err = await sdkFetch('/api/x', client.init()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, data: '<html>Bad gateway</html>' });
  });

  it('an empty error body with a JSON content-type is also an ApiError', async () => {
    const client = clientAnswering(() => brokenJson(500, ''));

    const err = await sdkFetch('/api/x', client.init()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, data: '' });
  });

  it('a valid JSON error body is still parsed (message and data)', async () => {
    const client = clientAnswering(() =>
      brokenJson(402, JSON.stringify({ code: 'LIMIT', message: 'Limit reached' }))
    );

    const err = await sdkFetch('/api/x', client.init()).catch((e: unknown) => e);

    expect(err).toMatchObject({
      status: 402,
      message: 'Limit reached',
      data: { code: 'LIMIT', message: 'Limit reached' },
    });
  });

  it('sdkFetchBlob: same tolerant error path', async () => {
    const client = clientAnswering(() => brokenJson(503));

    const err = await sdkFetchBlob('/api/export', client.init()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503 });
  });
});
