import type { Int } from 'grats';

// `Intl.DurationFormat` is stage 4 and shipped in Node 24, but
// TypeScript 5.9's lib types do not yet declare it. Drop the shim
// once `@types/node` / the TS lib catches up.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Intl {
  type DurationInput = {
    hours?: number;
    minutes?: number;
    seconds?: number;
  };
  class DurationFormat {
    constructor(
      locales?: string | string[],
      options?: {
        style?: 'long' | 'short' | 'narrow' | 'digital';
        hoursDisplay?: 'auto' | 'always';
      },
    );
    format(duration: DurationInput): string;
  }
}

const durationFormatter = new Intl.DurationFormat('en-GB', {
  style: 'digital',
  hoursDisplay: 'auto',
});

/**
 * A length of time, expressed in whole seconds.
 *
 * @gqlType
 */
export class Duration {
  /** @gqlField */
  readonly seconds: Int;

  constructor(seconds: Int) {
    this.seconds = seconds;
  }

  /** Human-readable form, e.g. `"05:32"` or `"1:02:14"` for spans at least an hour long. @gqlField */
  formatted(): string {
    const s = Math.max(0, Math.floor(this.seconds));
    const hours = Math.floor(s / 3600);
    return durationFormatter.format({
      ...(hours > 0 ? { hours } : {}),
      minutes: Math.floor((s % 3600) / 60),
      seconds: s % 60,
    });
  }
}
