import { ApiError, configureApiSdk, listRoutes } from '@patroltech/sdk-api';

import { openApiSession } from './oauth';

// `accessToken` is the OAuth access token obtained in ./oauth.ts.
export async function printRoutes(accessToken: string, organizationId: string): Promise<void> {
  let session = await openApiSession(accessToken);
  configureApiSdk({
    baseUrl: 'https://api.patroltech.online',
    getAccessToken: () => session.token,
    // On a 401 the SDK calls this once and retries with whatever getAccessToken()
    // returns now, so update the session it reads. Return null to give up.
    onUnauthorized: async () => {
      session = await openApiSession(accessToken);
      return session.token;
    },
  });

  try {
    const response = await listRoutes({ organizationId, page: 1, limit: 20 });
    // Non-2xx responses throw, so this check only narrows the type.
    if (response.status === 200) {
      for (const route of response.data.results) {
        console.log(`${route.name} (${route.isActive ? 'active' : 'inactive'})`);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`PatrolTech API answered ${error.status}: ${error.message}`);
    }
    throw error;
  }
}
