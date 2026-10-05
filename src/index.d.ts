export type Variables = Record<string, unknown>;
export interface Pair { key: string; value: string }

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api_key'; headerName: string; value: string }
  | { type: 'basic'; username: string; password?: string }
  | { type: 'custom'; headers: Record<string, string> };

export interface Connector {
  baseUrl: string;
  auth?: Auth;
  /** Extra headers sent with every request of this connector. */
  headers?: Pair[];
}

export interface Mapping {
  /** `$`, `$.a.b`, `$.items[0].name` or `$['key']`. */
  jsonPath: string;
  /** Name of the variable that receives the value. */
  variable: string;
  /** Default true: leave the variable out when the path does not resolve. */
  skipIfNull?: boolean;
}

export interface RequestDef {
  method?: string;
  /** May contain {{name}}. */
  path?: string;
  query?: Pair[];
  bodyType?: 'none' | 'json' | 'text';
  body?: string;
  responseType?: 'auto' | 'json' | 'text';
  mappings?: Mapping[];
  timeoutMs?: number;
}

export interface NetworkRules { allow?: string[]; deny?: string[] }

export interface FireResult {
  ok: boolean;
  status?: number;
  /** Variable name to value; non-string values are JSON text. */
  values: Record<string, string | null>;
  /** Parsed JSON, or the text for a non-JSON response. */
  body?: unknown;
  error?: string;
}

export function interpolate(text: string, variables?: Variables): string;
export function interpolatePairs(pairs: Pair[] | undefined, variables?: Variables): Pair[];
export function extractVariableNames(text: string): string[];
export function evaluateJsonPath(data: unknown, path: string): unknown;
export function parsePattern(pattern: string): { kind: 'host' | 'ip' | 'cidr'; value: string; port: number | null };
export function checkUrlAllowed(
  url: URL,
  options?: NetworkRules & { lookup?: (host: string, opts: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>> },
): Promise<{ allowed: boolean; reason?: string }>;
export function buildAuthHeaders(auth: Auth | undefined, variables?: Variables): Record<string, string>;
export function buildRequest(
  connector: Connector,
  request: RequestDef,
  variables?: Variables,
): { url: URL; method: string; headers: Record<string, string>; body?: string };
export function mapResponse(mappings: Mapping[] | undefined, body: unknown): Record<string, string | null>;
export function fireRequest(args: {
  connector: Connector;
  request: RequestDef;
  variables?: Variables;
  network?: NetworkRules;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<FireResult>;
