import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/request-queue.js';

test('queue cancels abandoned requests without running them', async () => {
  const queue = new RequestQueue({ gapMs: 0, maxWaitMs: 1000 });
  let release;
  const active = queue.enqueue(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  let called = false;
  const pending = queue.enqueue(() => { called = true; }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /canceled/);
  release(); await active;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
});

test('queue limits its size and waiting time', async () => {
  const queue = new RequestQueue({ gapMs: 0, maxQueued: 1, maxWaitMs: 20 });
  let release;
  const active = queue.enqueue(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const waiting = queue.enqueue(() => 1);
  await assert.rejects(queue.enqueue(() => 2), /queue is full/i);
  await assert.rejects(waiting, /wait timed out/i);
  release(); await active;
});

test('queue immediately rejects work beyond its usable waiting capacity', async () => {
  const queue = new RequestQueue({ gapMs: 10, maxQueued: 2, maxWaitMs: 100 });
  const started = [];
  const jobs = [1, 2, 3].map(id => queue.enqueue(() => { started.push(id); return id; }));
  await assert.rejects(queue.enqueue(() => 4), /queue is full/i);
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
});
