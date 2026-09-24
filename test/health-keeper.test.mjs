// keeper supply gating: halted units are skipped, health errors fail open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keeperSupplyTick } from '../src/watch.mjs';

test('keeperSupplyTick: halted unit skipped, ok unit checked', async () => {
  const calls = [];
  const upstreams = [
    { id: 'a', supply: { check: () => calls.push('a') } },
    { id: 'b', supply: { check: () => calls.push('b') } },
  ];
  const healthFor = async (u) => (u.id === 'a' ? { status: 'halted', reason: 'no-credit' } : { status: 'ok' });
  await keeperSupplyTick({ upstreams, healthFor });
  assert.deepEqual(calls, ['b']);
});

test('keeperSupplyTick: degraded no-credit (actions stopSupply) skipped, pool not gated', async () => {
  const calls = [];
  const upstreams = [
    { id: 'a', supply: { check: () => calls.push('a') } },
    { id: 'b', supply: { check: () => calls.push('b') } },
  ];
  const healthFor = async (u) => (u.id === 'a'
    ? { status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar', 'stopSupply'] }
    : { status: 'ok' });
  await keeperSupplyTick({ upstreams, healthFor });
  assert.deepEqual(calls, ['b']);
});

test('keeperSupplyTick: health unreadable fails open (supply still checked)', async () => {
  const calls = [];
  const upstreams = [{ id: 'a', supply: { check: () => calls.push('a') } }];
  await keeperSupplyTick({ upstreams, healthFor: async () => { throw new Error('disk gone'); } });
  assert.deepEqual(calls, ['a']);
});

test('keeperSupplyTick: no health configured checks everything; supply errors stay non-fatal', async () => {
  const calls = [];
  const upstreams = [
    { id: 'a', supply: { check: () => calls.push('a') } },
    { id: 'b', supply: { check: () => { throw new Error('spawn failed'); } } },
    { id: 'c' },
  ];
  await keeperSupplyTick({ upstreams });
  assert.deepEqual(calls, ['a']);
});
