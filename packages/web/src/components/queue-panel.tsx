import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Menu, X } from 'lucide-react';
import { useState } from 'react';

import { graphql, type ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { playOrderChanged } from '../state/play-order.ts';
import { queueIdValue } from '../state/queue.ts';
import { Button } from './ui/button.tsx';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from './ui/sheet.tsx';

const QueuePanelDocument = graphql(`
  query QueuePanel($id: ID) {
    playbackQueue(id: $id) {
      id
      tracksQueued(first: 500) {
        totalCount
        edges {
          node {
            id
            title
            artist
            duration {
              formatted
            }
          }
        }
      }
    }
  }
`);

const QueuePanelRemoveDocument = graphql(`
  mutation QueuePanelRemove($id: ID!, $trackId: ID!, $index: Int!) {
    queueRemove(id: $id, trackId: $trackId, index: $index) {
      id
    }
  }
`);

const QueuePanelReorderDocument = graphql(`
  mutation QueuePanelReorder($id: ID!, $trackId: ID!, $fromIndex: Int!, $toIndex: Int!) {
    queueReorder(id: $id, trackId: $trackId, fromIndex: $fromIndex, toIndex: $toIndex) {
      id
    }
  }
`);

const QueuePanelClearDocument = graphql(`
  mutation QueuePanelClear($id: ID!) {
    queueClear(id: $id) {
      _
    }
  }
`);

/** A reorder only ever changes a row's position in the list, so the drag follows the pointer vertically only. */
const verticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type QueueNode = NonNullable<
  ResultOf<typeof QueuePanelDocument>['playbackQueue']
>['tracksQueued']['edges'][number]['node'];

/** One queue entry. The sortable id is `index:trackId` — the same track may be queued twice, so the index disambiguates. */
type Entry = { key: string; index: number; node: QueueNode };

function QueueRow({ entry, onRemove }: { entry: Entry; onRemove: (entry: Entry) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.key,
  });
  return (
    <li
      ref={setNodeRef}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40"
      style={{
        transform: transform ? `translateY(${transform.y}px)` : undefined,
        transition: transition ?? undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground/60 hover:text-foreground"
        aria-label="Reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.node.title ?? '(untitled)'}</span>
        <span className="truncate text-xs text-muted-foreground">
          {entry.node.artist ?? 'Unknown artist'}
        </span>
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {entry.node.duration.formatted}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => onRemove(entry)}
        aria-label="Remove from queue"
      >
        <X />
      </Button>
    </li>
  );
}

function QueueList() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['playback-queue'],
    // The stored queue id is read at fetch time (not baked into the key), so the first append of
    // a session reaches this same cache entry through invalidation.
    queryFn: ({ signal }) => gqlRequest(QueuePanelDocument, { id: queueIdValue() }, signal),
    staleTime: 0,
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const queue = data?.playbackQueue;
  const entries: Entry[] =
    queue?.tracksQueued.edges.map((e, index) => ({
      key: `${index}:${e.node.id}`,
      index,
      node: e.node,
    })) ?? [];

  const mutate = (fn: () => Promise<unknown>) => {
    void fn()
      .catch(() => undefined)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['playback-queue'] });
        playOrderChanged();
      });
  };

  const onRemove = (entry: Entry) => {
    if (!queue?.id) return;
    const id = queue.id;
    mutate(() =>
      gqlRequest(QueuePanelRemoveDocument, { id, trackId: entry.node.id, index: entry.index }),
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!queue?.id || !event.over) return;
    const id = queue.id;
    const from = entries.findIndex((e) => e.key === event.active.id);
    const to = entries.findIndex((e) => e.key === event.over!.id);
    if (from < 0 || to < 0 || from === to) return;
    mutate(() =>
      gqlRequest(QueuePanelReorderDocument, {
        id,
        trackId: entries[from]!.node.id,
        fromIndex: from,
        toIndex: to,
      }),
    );
  };

  const onClear = () => {
    if (!queue?.id) return;
    const id = queue.id;
    mutate(() => gqlRequest(QueuePanelClearDocument, { id }));
  };

  let body = null;
  if (isLoading) {
    body = <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  } else if (entries.length === 0) {
    body = (
      <div className="p-4 text-sm text-muted-foreground">
        Nothing queued. Right-click a track (or swipe it right on a touchscreen) to play it next.
      </div>
    );
  } else {
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={entries.map((e) => e.key)} strategy={verticalListSortingStrategy}>
          <ul className="flex-1 overflow-y-auto p-1.5">
            {entries.map((entry) => (
              <QueueRow key={entry.key} entry={entry} onRemove={onRemove} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border py-2 pl-3 pr-2">
        <SheetTitle>
          Queue
          {entries.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {queue?.tracksQueued.totalCount}
            </span>
          )}
        </SheetTitle>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={onClear}
            disabled={entries.length === 0}
          >
            Clear
          </Button>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close">
              <X />
            </Button>
          </SheetClose>
        </span>
      </div>
      {body}
    </div>
  );
}

/** The play-queue button and side panel in the header. The panel queries on open, so an unopened queue costs nothing. */
export function QueuePanel() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Play queue">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <QueueList />
      </SheetContent>
    </Sheet>
  );
}
