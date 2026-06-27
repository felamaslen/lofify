import './styles.css';

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Toaster } from './components/ui/sonner.tsx';
import { queryClient } from './lib/query-client.ts';
import { Home } from './routes/home.tsx';
import { PlayerProvider } from './state/player.tsx';
import { ThemeProvider } from './state/theme.tsx';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});

// A shared link (`/share/<trackId>`) renders the same screen; `Home` reads the
// id off the path and shows the focused landing for it. The id is read straight
// from the URL (like every other URL state here) rather than the route param,
// so it stays consistent with the player's raw History-API writes.
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share/$trackId',
  component: Home,
});

const routeTree = rootRoute.addChildren([indexRoute, shareRoute]);
// The page scrolls (body scroll), so the router would otherwise reset window
// scroll to the top on every navigation — including the player's ~2s playhead
// writes to the URL. Scroll restoration preserves position per history entry
// instead; the player keeps the same entry (it preserves history.state), so it
// stays put while scrolling a playing library.
const router = createRouter({ routeTree, scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <PlayerProvider>
          <RouterProvider router={router} />
        </PlayerProvider>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
