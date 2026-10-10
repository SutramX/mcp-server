export const SERVER_NAME = 'sutramx-mcp-server';
export const SERVER_VERSION = '0.1.4';
export const DEFAULT_API_URL = 'https://api.sutramx.com';
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Responses longer than this are truncated with a hint to filter or paginate. */
export const CHARACTER_LIMIT = 25_000;
