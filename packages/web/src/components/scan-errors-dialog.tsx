import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx';

const PAGE_SIZE = 20;

const LibraryScanErrorsDocument = graphql(`
  query LibraryScanErrors($first: Int!, $after: ID) {
    libraryScanErrors(first: $first, after: $after) {
      totalCount
      edges {
        node {
          id
          filename
          message
          attemptedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`);

const RetryScanErrorDocument = graphql(`
  mutation RetryScanError($id: ID!) {
    libraryScanErrorRetry(id: $id) {
      _
    }
  }
`);

const DismissScanErrorDocument = graphql(`
  mutation DismissScanError($id: ID!) {
    libraryScanErrorDismiss(id: $id) {
      _
    }
  }
`);

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function ScanErrorsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Record<string, 'retry' | 'dismiss'>>({});

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['libraryScanErrors', 'list'],
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gqlRequest(LibraryScanErrorsDocument, { first: PAGE_SIZE, after: pageParam }, signal),
    getNextPageParam: (lastPage) => {
      const info = lastPage.libraryScanErrors?.pageInfo;
      return info?.hasNextPage ? info.endCursor : undefined;
    },
  });

  const edges = data?.pages.flatMap((page) => page.libraryScanErrors?.edges ?? []) ?? [];
  const totalCount = data?.pages[0]?.libraryScanErrors?.totalCount ?? 0;

  const act = async (id: string, action: 'retry' | 'dismiss') => {
    setBusy((b) => ({ ...b, [id]: action }));
    try {
      if (action === 'retry') {
        await gqlRequest(RetryScanErrorDocument, { id });
        // A retry that succeeds ingests a track, which can change list windows,
        // counts and the letter index — so refetch broadly. The errors query is
        // covered by the same blanket invalidation.
        await queryClient.invalidateQueries();
      } else {
        await gqlRequest(DismissScanErrorDocument, { id });
        await queryClient.invalidateQueries({ queryKey: ['libraryScanErrors'] });
      }
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scan errors</DialogTitle>
          <DialogDescription>
            {totalCount === 0
              ? 'No files are currently failing to scan.'
              : `${totalCount} file${totalCount === 1 ? '' : 's'} failed to scan and ${totalCount === 1 ? 'is' : 'are'} being skipped. Retry once fixed, or dismiss to stop tracking.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : edges.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nothing to review.
            </div>
          ) : (
            <ul className="grid gap-1.5">
              {edges.map(({ node }) => {
                const pending = busy[node.id];
                return (
                  <li
                    key={node.id}
                    className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={node.filename}>
                        {basename(node.filename)}
                      </div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={node.filename}
                      >
                        {node.filename}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                          {node.message}
                        </span>
                        <span>{new Date(node.attemptedAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending != null}
                        onClick={() => void act(node.id, 'retry')}
                      >
                        {pending === 'retry' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        Retry
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Dismiss"
                        title="Dismiss"
                        disabled={pending != null}
                        onClick={() => void act(node.id, 'dismiss')}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive-foreground"
                      >
                        {pending === 'dismiss' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasNextPage && (
            <div className="flex justify-center pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage && <Loader2 className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
