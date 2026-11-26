import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeadlineHighlight, getContrastTextPalette } from './deadlineHighlight';

test('computeDeadlineHighlight returns none when deadlineAt is missing', () => {
  const res = computeDeadlineHighlight({
    startAt: '2026-11-20T00:00:00.000Z',
    deadlineAt: null,
    defaultStroke: '#22C58B',
  });
  assert.equal(res.level, 'none');
  assert.equal(res.strokeColor, '#22C58B');
  assert.equal(res.remainingPercent, null);
});

test('computeDeadlineHighlight returns green (>50%), yellow (25-50%), orange (5-25%), and red (<=5% or overdue)', () => {
  const startAt = '2026-11-01T00:00:00.000Z';
  const deadlineAt = '2026-11-21T00:00:00.000Z'; // 20 days total
  const startMs = Date.parse(startAt);
  const totalMs = Date.parse(deadlineAt) - startMs;

  // 75% remaining -> green
  const green = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: startMs + totalMs * 0.25,
    defaultStroke: '#ccc',
  });
  assert.equal(green.level, 'green');
  assert.equal(green.remainingPercent, 75);

  // 40% remaining -> yellow
  const yellow = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: startMs + totalMs * 0.6,
    defaultStroke: '#ccc',
  });
  assert.equal(yellow.level, 'yellow');
  assert.equal(yellow.remainingPercent, 40);

  // 15% remaining -> orange
  const orange = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: startMs + totalMs * 0.85,
    defaultStroke: '#ccc',
  });
  assert.equal(orange.level, 'orange');
  assert.equal(orange.remainingPercent, 15);

  // 5% remaining -> red (exact 5% threshold)
  const redExact5 = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: startMs + totalMs * 0.95,
    defaultStroke: '#ccc',
  });
  assert.equal(redExact5.level, 'red');
  assert.equal(redExact5.remainingPercent, 5);

  // 2% remaining -> red
  const red2 = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: startMs + totalMs * 0.98,
    defaultStroke: '#ccc',
  });
  assert.equal(red2.level, 'red');
  assert.equal(red2.remainingPercent, 2);

  // Overdue -> red
  const overdue = computeDeadlineHighlight({
    startAt,
    deadlineAt,
    nowMs: Date.parse(deadlineAt) + 3600_000,
    defaultStroke: '#ccc',
  });
  assert.equal(overdue.level, 'red');
  assert.equal(overdue.remainingPercent, 0);
  assert.ok(overdue.remainingLabel.startsWith('Overdue'));
});

test('getContrastTextPalette picks dark ink on light custom colors and light ink on dark custom colors', () => {
  const darkPalette = getContrastTextPalette('#0A2920');
  assert.equal(darkPalette.isLight, false);
  assert.equal(darkPalette.titleColor, '#F8FAFC');

  const lightPalette = getContrastTextPalette('#DFE4D8');
  assert.equal(lightPalette.isLight, true);
  assert.equal(lightPalette.titleColor, '#14110F');
});
