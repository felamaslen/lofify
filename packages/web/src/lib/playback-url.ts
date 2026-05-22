const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL ?? '/graphql';

function backendOrigin(): string {
  try {
    return new URL(GRAPHQL_URL, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function resolvePlaybackUrl(url: string): string {
  if (/^https?:/i.test(url)) return url;
  return `${backendOrigin()}${url}`;
}
