import {
  createApiClient,
  createOAuthAgentSession,
  getStartOAuthAuthorizationUrl,
  registerOAuthClient,
  requestOAuthToken,
} from '@patroltech/sdk-api';

const baseUrl = 'https://api.patroltech.online';
// OAuth endpoints need no API session: a client with just the base URL.
const anonymous = createApiClient({ baseUrl });

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** PKCE S256 pair (RFC 7636), with Web Crypto: works in Node.js 22+ and browsers. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Step 1, once per integration: dynamic client registration (RFC 7591). */
export async function registerClient(redirectUri: string): Promise<string> {
  const response = await registerOAuthClient(
    { client_name: 'My PatrolTech integration', redirect_uris: [redirectUri] },
    anonymous.init()
  );
  if (response.status !== 201) throw new Error('Client registration failed');
  return response.data.client_id;
}

/** Unguessable `state` for step 2: keep it in the user's session and compare it in step 3. */
export function createState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Step 2: send the user to this URL; PatrolTech redirects back with `code` and `state`. */
export function authorizationUrl(
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string
): string {
  return `${baseUrl}${getStartOAuthAuthorizationUrl({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;
}

/**
 * Step 3: on the redirect, check `state` (CSRF) and exchange the code for an OAuth
 * token pair. Keep the refresh token secret, server-side.
 */
export async function exchangeCode(
  clientId: string,
  redirectUri: string,
  callback: { code: string; state: string },
  expected: { state: string; verifier: string }
): Promise<{ accessToken: string; refreshToken: string }> {
  if (callback.state !== expected.state) throw new Error('OAuth state mismatch');
  const response = await requestOAuthToken(
    {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.code,
      redirect_uri: redirectUri,
      code_verifier: expected.verifier,
    },
    anonymous.init()
  );
  if (response.status !== 200) throw new Error('Token exchange failed');
  return { accessToken: response.data.access_token, refreshToken: response.data.refresh_token };
}

/** Step 4: trade the OAuth access token for a short-lived API session used on `/api/*`. */
export async function openApiSession(
  accessToken: string
): Promise<{ token: string; expiresAt: number }> {
  const oauthClient = createApiClient({ baseUrl, getAccessToken: () => accessToken });
  const response = await createOAuthAgentSession(oauthClient.init());
  if (response.status !== 200) throw new Error('Could not open an API session');
  return { token: response.data.token, expiresAt: response.data.expires_at };
}
