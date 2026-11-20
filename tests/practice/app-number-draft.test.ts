import test from 'node:test';
import assert from 'node:assert/strict';
import { liveNumber, settleNumber } from '../../src/app/number-draft';

const tempo = { min: 30, max: 240 };

test('typing toward a valid tempo never commits a clamped intermediate value', () => {
  // "1" and "12" on the way to "120" are kept as drafts, not snapped to 30.
  assert.deepEqual(
    ['1', '12', '120'].map((draft) => liveNumber(draft, tempo)),
    [null, null, 120],
  );
  assert.equal(liveNumber('', tempo), null);
  assert.equal(liveNumber('241', tempo), null);
  assert.equal(liveNumber('88.5', tempo), null);
  assert.equal(liveNumber(' 72 ', tempo), 72);
});

test('settling a draft keeps valid values, clamps numbers and restores blanks with a hint', () => {
  assert.deepEqual(settleNumber('120', tempo, 88), { value: 120, message: '' });
  assert.deepEqual(settleNumber('12', tempo, 88), { value: 30, message: '请输入 30 至 240 的整数，已改为 30。' });
  assert.deepEqual(settleNumber('300', tempo, 88), { value: 240, message: '请输入 30 至 240 的整数，已改为 240。' });
  assert.deepEqual(settleNumber('88.6', tempo, 88), { value: 89, message: '请输入 30 至 240 的整数，已改为 89。' });
  assert.deepEqual(settleNumber('', tempo, 88), { value: 88, message: '请输入 30 至 240 的整数，已恢复为 88。' });
});

test('loop end below the start is a draft until settled to the start', () => {
  const end = { min: 5, max: 8 };
  assert.equal(liveNumber('1', end), null);
  assert.equal(liveNumber('6', end), 6);
  assert.deepEqual(settleNumber('1', end, 5), { value: 5, message: '请输入 5 至 8 的整数，已改为 5。' });
});
