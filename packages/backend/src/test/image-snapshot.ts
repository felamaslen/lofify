import { type MatchImageSnapshotOptions, toMatchImageSnapshot } from 'jest-image-snapshot';
import { expect } from 'vitest';

// jest-image-snapshot's matcher runs against vitest's jest-compatible expect context. Import this module for its side effect before using the matcher.
expect.extend({ toMatchImageSnapshot });

declare module 'vitest' {
  interface Matchers<T> {
    toMatchImageSnapshot: (options?: MatchImageSnapshotOptions) => T;
  }
}
