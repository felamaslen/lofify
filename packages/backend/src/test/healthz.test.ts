import { app } from '../app.js';

test('GET /healthz returns ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
