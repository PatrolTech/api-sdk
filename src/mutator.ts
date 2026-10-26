export interface ApiSdkConfig {
  baseUrl?: string;
  getAccessToken?: () => string | null | Promise<string | null>;
  defaultHeaders?: Record<string, string> | (() => Record<string, string>);
  fetchImpl?: typeof fetch;
  /**
   * Called when a request receives a 401 response.
   * Should attempt to refresh the token and return the new token string,
   * or `null` if refresh failed (which will throw the original 401 error).
   */
  onUnauthorized?: () => Promise<string | null>;
  /**
   * Called when a request receives a 423 for a suspended organization (body
   * with `code: 'ORGANIZATION_SUSPENDED'`), with the response body, right
   * before the `ApiError` is thrown. Other 423 responses (e.g. a locked field)
   * do not trigger it: the caller only gets the `ApiError`.
   */
  onSuspended?: (data: unknown) => void;
}

/**
 * Per-call request options. Extends the standard RequestInit with an opt-out for
 * the ambient session Bearer: when `skipSessionAuth` is true the caller supplies
 * its own identity via headers (e.g. patroller app-auth for an offline-queued
 * scan that belongs to a different session than the active one).
 */
export interface SdkRequestInit extends RequestInit {
  skipSessionAuth?: boolean;
  /**
   * Per-request configuration. When present it REPLACES the global one set with
   * `configureApiSdk` for this call (base URL, token, headers, fetch, hooks), so
   * a multi-tenant server can call the SDK with a different identity on every
   * request without touching the shared singleton. It is never forwarded to fetch.
   */
  apiConfig?: ApiSdkConfig;
}

/**
 * Error thrown by the SDK when the server returns a non-OK response.
 * Carries the HTTP status code and the server error message.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let sdkConfig: ApiSdkConfig = {};

export function configureApiSdk(config: ApiSdkConfig): void {
  sdkConfig = { ...sdkConfig, ...config };
}

/** The per-request config wins over the global singleton; there is no field-by-field merge. */
function resolveConfig(options?: SdkRequestInit): ApiSdkConfig {
  return options?.apiConfig ?? sdkConfig;
}

/**
 * Client bound to one explicit configuration. Spread `init()` as the last
 * argument of any generated SDK function to run that call with this config
 * instead of the global one: `await getThing(id, client.init())`.
 */
export interface ApiClient {
  init(extra?: RequestInit): SdkRequestInit;
}

export function createApiClient(config: ApiSdkConfig): ApiClient {
  return {
    init: (extra) => ({ ...extra, apiConfig: config }),
  };
}

async function buildAuthorizationHeader(cfg: ApiSdkConfig): Promise<Record<string, string>> {
  const token = await cfg.getAccessToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function resolveDefaultHeaders(cfg: ApiSdkConfig): Record<string, string> {
  if (!cfg.defaultHeaders) return {};
  return typeof cfg.defaultHeaders === 'function' ? cfg.defaultHeaders() : cfg.defaultHeaders;
}

/**
 * The generated client percent-encodes path parameters
 * (`scripts/encode-path-params.mjs`), but `.` and `..` survive the encoding and
 * URL parsing resolves them (also as `%2e`). Refusing them, plus backslashes and
 * control characters that URL parsing rewrites or drops, keeps an untrusted id
 * (`..`) from sending the caller's token to another endpoint of the API.
 */
function assertSafePath(url: string): void {
  const path = url.split(/[?#]/, 1)[0];
  const hasDotSegment = path
    .split('/')
    .some((segment) => ['.', '..'].includes(segment.toLowerCase().replace(/%2e/g, '.')));
  if (hasDotSegment || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError(`Refusing an unsafe request path: ${JSON.stringify(path)}`);
  }
}

async function doFetch(url: string, options?: SdkRequestInit): Promise<Response> {
  assertSafePath(url);
  const cfg = resolveConfig(options);
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const { skipSessionAuth, apiConfig: _apiConfig, ...requestInit } = options ?? {};
  const authHeaders = skipSessionAuth ? {} : await buildAuthorizationHeader(cfg);
  const fullUrl = `${cfg.baseUrl ?? ''}${url}`;
  return fetchImpl(fullUrl, {
    ...requestInit,
    headers: {
      ...resolveDefaultHeaders(cfg),
      ...authHeaders,
      ...(requestInit.headers ?? {}),
    },
  });
}

/**
 * Error body that claims to be JSON: parsed if it is, otherwise the raw text
 * (a proxy page, an empty body). A broken error body must still surface as an
 * `ApiError` with its HTTP status, never as a `SyntaxError` that hides it.
 */
async function parseErrorJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseResponseBody(response: Response, options?: RequestInit): Promise<unknown> {
  const isHeadRequest = options?.method?.toUpperCase() === 'HEAD';
  const contentType = response.headers.get('content-type') ?? '';
  if (isHeadRequest || response.status === 204) {
    return Promise.resolve(undefined);
  } else if (contentType.includes('application/json')) {
    return response.ok ? response.json() : parseErrorJson(response);
  } else {
    return response.text();
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (data != null && typeof data === 'object' && 'message' in (data as Record<string, unknown>)) {
    return String((data as Record<string, unknown>).message);
  }
  return `Request failed with status ${status}`;
}

const ORGANIZATION_SUSPENDED_CODE = 'ORGANIZATION_SUSPENDED';

/** A 423 is a suspension when its body says so (envelope `{ data: { code } }` or already unwrapped). */
function isSuspendedBody(data: unknown): boolean {
  if (data == null || typeof data !== 'object') return false;
  const body = data as Record<string, unknown>;
  const payload =
    body.data != null && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : body;
  return payload.code === ORGANIZATION_SUSPENDED_CODE;
}

/**
 * Tells the client about a 423 for a suspended organization; ignores other 423s.
 * A failing handler must never hide the `ApiError` the caller expects.
 */
function notifySuspended(cfg: ApiSdkConfig, data: unknown): void {
  if (!isSuspendedBody(data)) return;
  try {
    cfg.onSuspended?.(data);
  } catch (error) {
    console.error('onSuspended handler failed', error);
  }
}

export async function sdkFetch<T>(url: string, options?: SdkRequestInit): Promise<T> {
  const cfg = resolveConfig(options);
  let response = await doFetch(url, options);
  let data = await parseResponseBody(response, options);

  // On 401, attempt a single token refresh + retry
  if (response.status === 401 && cfg.onUnauthorized) {
    const newToken = await cfg.onUnauthorized();
    if (newToken) {
      // Retry the request with the fresh token
      response = await doFetch(url, options);
      data = await parseResponseBody(response, options);
    }
  }

  // For non-OK responses, throw an ApiError with the server message
  if (!response.ok) {
    if (response.status === 423) notifySuspended(cfg, data);
    throw new ApiError(response.status, extractErrorMessage(data, response.status), data);
  }

  // Auto-unwrap ApiResponse envelope: { success, data, ... } → inner data
  // Preserve extra envelope fields (e.g. token) so callers can still access them.
  let unwrapped = data;
  let envelopeExtras: Record<string, unknown> = {};
  if (
    data != null &&
    typeof data === 'object' &&
    'success' in (data as Record<string, unknown>) &&
    'data' in (data as Record<string, unknown>)
  ) {
    const { success: _s, data: innerData, ...rest } = data as Record<string, unknown>;
    unwrapped = innerData;
    envelopeExtras = rest;
  }

  return {
    ...envelopeExtras,
    data: unwrapped,
    status: response.status,
    headers: response.headers,
  } as T;
}

/**
 * Binary-safe sibling of `sdkFetch` for endpoints that return a file (e.g. a
 * PDF) instead of a JSON envelope. It keeps the same base URL, Bearer token and
 * 401-refresh retry as every other call, and fails loudly when the response is
 * an HTML page (the request never reached the API).
 */
export async function sdkFetchBlob(url: string, options?: SdkRequestInit): Promise<Blob> {
  const cfg = resolveConfig(options);
  let response = await doFetch(url, options);

  if (response.status === 401 && cfg.onUnauthorized) {
    const newToken = await cfg.onUnauthorized();
    if (newToken) {
      response = await doFetch(url, options);
    }
  }

  if (!response.ok) {
    const data = await parseResponseBody(response, options);
    if (response.status === 423) notifySuspended(cfg, data);
    throw new ApiError(response.status, extractErrorMessage(data, response.status), data);
  }

  // An HTML body on a file endpoint means the request never reached the API.
  // Failing loudly here beats handing the caller a Blob it would happily save
  // as a corrupt document.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new ApiError(
      response.status,
      'Expected a file response but received an HTML document',
      await response.text()
    );
  }

  return response.blob();
}
