import { isDiskFullError } from './sweep.js';

test('isDiskFullError recognises ENOSPC-tagged errors', () => {
  const enospc = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  expect(isDiskFullError(enospc)).toBe(true);
});

test('isDiskFullError ignores other errors and non-errors', () => {
  expect(isDiskFullError(Object.assign(new Error('boom'), { code: 'EACCES' }))).toBe(false);
  expect(isDiskFullError(new Error('plain'))).toBe(false);
  expect(isDiskFullError(null)).toBe(false);
  expect(isDiskFullError('ENOSPC')).toBe(false);
});
