/** The web fetch call boundary, without runtime-specific static helpers. */
export type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
