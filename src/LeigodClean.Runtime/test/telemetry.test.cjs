'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RANGES,
  appendSample,
  createChartModel,
  visibleSamples,
} = require('../renderer/telemetry.js');

test('telemetry sampling coalesces rapid updates and bounds retained history', () => {
  const series = [];
  appendSample(series, { at: 10_000, value: 20 });
  appendSample(series, { at: 10_500, value: 25 });
  assert.deepEqual(series, [{ at: 10_500, value: 25 }]);

  appendSample(series, { at: 12_100, value: 30 });
  appendSample(series, { at: 14_000, value: 35 }, { maxPoints: 2 });
  assert.deepEqual(series, [
    { at: 12_100, value: 30 },
    { at: 14_000, value: 35 },
  ]);
});

test('visible samples preserve the point immediately before the selected range', () => {
  const now = 1_000_000;
  const series = [
    { at: now - RANGES.minute - 1_000, value: 20 },
    { at: now - RANGES.minute + 1_000, value: 30 },
    { at: now, value: 40 },
  ];
  assert.deepEqual(visibleSamples(series, RANGES.minute, now), series);
});

test('chart model projects delay samples and computes a padded domain', () => {
  const now = 1_000_000;
  const model = createChartModel([
    { at: now - 30_000, value: 20 },
    { at: now, value: 40 },
  ], {
    metric: 'delay',
    now,
    rangeMs: RANGES.minute,
    width: 200,
    height: 100,
  });
  assert.equal(model.points.length, 2);
  assert.equal(model.points[0].x, 100);
  assert.equal(model.points[1].x, 200);
  assert.equal(model.summary.average, 30);
  assert.ok(model.domain.minimum < 20);
  assert.ok(model.domain.maximum > 40);
});

test('packet-loss charts stay anchored at zero with a useful minimum scale', () => {
  const now = 2_000_000;
  const model = createChartModel([{ at: now, value: 0 }], {
    metric: 'loss',
    now,
    rangeMs: RANGES.fiveMinutes,
    width: 100,
    height: 40,
  });
  assert.equal(model.domain.minimum, 0);
  assert.equal(model.domain.maximum, 1);
  assert.equal(model.points[0].y, 40);
});
