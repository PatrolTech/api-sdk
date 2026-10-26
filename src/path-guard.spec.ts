import { describe, expect, it, vi } from 'vitest';
import { createApiClient, updateLocation } from './index';

function clientWithFetch() {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
  const client = createApiClient({ baseUrl: 'http://r', fetchImpl: fetchImpl as typeof fetch });
  return { client, fetchImpl };
}

describe('path parameters cannot reach another endpoint', () => {
  it.each(['../users', '..', '.', '%2e%2E/x', 'a\\..\\b', 'x/../../admin'])(
    'refuses %s before calling fetch',
    async (id) => {
      const { client, fetchImpl } = clientWithFetch();

      await expect(updateLocation(id, {} as never, client.init())).rejects.toThrow(TypeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('lets ordinary ids through', async () => {
    const { client, fetchImpl } = clientWithFetch();

    await updateLocation('loc-1.v2', {} as never, client.init());

    expect(fetchImpl.mock.calls[0][0]).toBe('http://r/api/locations/loc-1.v2');
  });
});
