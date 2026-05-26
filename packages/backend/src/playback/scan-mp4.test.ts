import { makeMp4Scanner } from './scan-mp4.js';

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (type.length !== 4) throw new Error('type must be 4 ascii chars');
  const size = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function bigBox(type: string, payload: Buffer): Buffer {
  if (type.length !== 4) throw new Error('type must be 4 ascii chars');
  const size = 16 + payload.length;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'ascii');
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(size, 12);
  return Buffer.concat([header, payload]);
}

const NOMINAL_SECS = 6;
const scanner = makeMp4Scanner(NOMINAL_SECS);

test('init-only buffer emits nothing — init end is not known yet', () => {
  const buf = Buffer.concat([box('ftyp', Buffer.alloc(16)), box('moov', Buffer.alloc(64))]);
  const r = scanner.scan(buf, 0, false);
  expect(r.init).toBeNull();
  expect(r.chunks).toEqual([]);
  expect(r.resumeOffset).toBe(buf.length);
});

test('first moof: init range is emitted, fragment is pending', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const moov = box('moov', Buffer.alloc(40));
  const moof1 = box('moof', Buffer.alloc(20));
  const mdat1 = box('mdat', Buffer.alloc(100));
  const moof1Off = ftyp.length + moov.length;
  const r = scanner.scan(Buffer.concat([ftyp, moov, moof1, mdat1]), 0, false);
  expect(r.init).toEqual([0, moof1Off]);
  expect(r.chunks).toEqual([]);
  expect(r.resumeOffset).toBe(moof1Off);
});

test('second moof finalises the first fragment with nominal duration', () => {
  const moof1 = box('moof', Buffer.alloc(20));
  const mdat1 = box('mdat', Buffer.alloc(100));
  const moof2 = box('moof', Buffer.alloc(20));
  const mdat2 = box('mdat', Buffer.alloc(80));
  const baseOffset = 1024;
  const moof2Off = baseOffset + moof1.length + mdat1.length;
  const r = scanner.scan(
    Buffer.concat([moof1, mdat1, moof2, mdat2]),
    baseOffset,
    false,
  );
  expect(r.init).toBeNull();
  expect(r.chunks).toEqual([{ byte: [baseOffset, moof2Off], durationSeconds: NOMINAL_SECS }]);
  expect(r.resumeOffset).toBe(moof2Off);
});

test('init + several fragments in a single call emit init and finalised chunks', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const moov = box('moov', Buffer.alloc(40));
  const moof1 = box('moof', Buffer.alloc(20));
  const mdat1 = box('mdat', Buffer.alloc(100));
  const moof2 = box('moof', Buffer.alloc(20));
  const mdat2 = box('mdat', Buffer.alloc(80));
  const moof3 = box('moof', Buffer.alloc(20));
  const mdat3 = box('mdat', Buffer.alloc(40));
  const a = ftyp.length + moov.length;
  const b = a + moof1.length + mdat1.length;
  const c = b + moof2.length + mdat2.length;
  const r = scanner.scan(
    Buffer.concat([ftyp, moov, moof1, mdat1, moof2, mdat2, moof3, mdat3]),
    0,
    false,
  );
  expect(r.init).toEqual([0, a]);
  expect(r.chunks).toEqual([
    { byte: [a, b], durationSeconds: NOMINAL_SECS },
    { byte: [b, c], durationSeconds: NOMINAL_SECS },
  ]);
  expect(r.resumeOffset).toBe(c);
});

test('isFinal=true flushes the pending trailing fragment using buf end', () => {
  const moof = box('moof', Buffer.alloc(20));
  const mdat = box('mdat', Buffer.alloc(40));
  const baseOffset = 500;
  const buf = Buffer.concat([moof, mdat]);
  const r = scanner.scan(buf, baseOffset, true);
  expect(r.chunks).toEqual([
    { byte: [baseOffset, baseOffset + buf.length], durationSeconds: NOMINAL_SECS },
  ]);
  expect(r.resumeOffset).toBe(baseOffset + buf.length);
});

test('isFinal=true with no pending fragment is a no-op', () => {
  const buf = box('ftyp', Buffer.alloc(8));
  const r = scanner.scan(buf, 0, true);
  expect(r.chunks).toEqual([]);
  expect(r.init).toBeNull();
  expect(r.resumeOffset).toBe(buf.length);
});

test('truncated trailing box leaves resumeOffset at the pending moof', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const moov = box('moov', Buffer.alloc(40));
  const moof = box('moof', Buffer.alloc(20));
  const mdat = box('mdat', Buffer.alloc(100));
  const truncated = Buffer.alloc(4);
  truncated.writeUInt32BE(28, 0);
  const moofOff = ftyp.length + moov.length;
  const r = scanner.scan(Buffer.concat([ftyp, moov, moof, mdat, truncated]), 0, false);
  expect(r.init).toEqual([0, moofOff]);
  expect(r.resumeOffset).toBe(moofOff);
});

test('honours 64-bit size-1 extended box headers', () => {
  const big = bigBox('moof', Buffer.alloc(48));
  const mdat = box('mdat', Buffer.alloc(16));
  const r = scanner.scan(Buffer.concat([big, mdat]), 0, false);
  expect(r.init).toEqual([0, 0]);
  expect(r.resumeOffset).toBe(0);
});

test('throws on a structurally invalid box size shorter than its header', () => {
  const malformed = Buffer.alloc(8);
  malformed.writeUInt32BE(4, 0);
  malformed.write('moof', 4, 'ascii');
  expect(() => scanner.scan(malformed, 0, false)).toThrow(/invalid box size/);
});

test('throws on size-0 boxes (unexpected for fragmented mp4)', () => {
  const sz0 = Buffer.alloc(8);
  sz0.writeUInt32BE(0, 0);
  sz0.write('moof', 4, 'ascii');
  expect(() => scanner.scan(sz0, 0, false)).toThrow(/size-0 box/);
});
