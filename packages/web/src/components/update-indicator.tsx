import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readFragment } from 'gql.tada';

import { type FragmentOf, graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { GIT_SHA } from '../lib/version.ts';
import { Hint } from './ui/hint.tsx';

const POLL_INTERVAL_MS = 60_000;

/** Whether the server is running a newer build than this bundle. Spread into the home bootstrap query (`routes/home.tsx`) so its value arrives with the first paint. */
export const UpdateIndicatorDocument = graphql(`
  fragment UpdateIndicator on Query {
    isUpdateAvailable(version: $appVersion)
  }
`);

const IsUpdateAvailableDocument = graphql(`
  query IsUpdateAvailable($appVersion: String!) {
    isUpdateAvailable(version: $appVersion)
  }
`);

/** A pulsing dot, pinned top-right, shown when the server reports a newer build than this bundle. Clicking reloads to pick it up (the autoUpdate service worker swaps in fresh assets on reload). */
export function UpdateIndicator() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['update-available', GIT_SHA],
    queryFn: ({ signal }) => gqlRequest(IsUpdateAvailableDocument, { appVersion: GIT_SHA }, signal),
    refetchInterval: POLL_INTERVAL_MS,
    // Seeded from the home bootstrap query and never stale, so its own first
    // request is deferred to the first poll; assume up-to-date until then. The
    // flag is filter-independent, so any home entry (keyed by its opening
    // filters) carries it.
    staleTime: Infinity,
    initialData: () => {
      const seed = queryClient
        .getQueriesData<FragmentOf<typeof UpdateIndicatorDocument>>({ queryKey: ['home', GIT_SHA] })
        .map(([, entry]) => entry)
        .find((entry) => entry != null);
      return seed ? readFragment(UpdateIndicatorDocument, seed) : { isUpdateAvailable: false };
    },
  });

  if (!data.isUpdateAvailable) return null;

  return (
    <Hint content="New version available — click to reload" side="bottom">
      <button
        type="button"
        onClick={() => window.location.reload()}
        aria-label="New version available — click to reload"
        className="relative ml-auto flex size-2.5 shrink-0"
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-amber-500" />
      </button>
    </Hint>
  );
}
