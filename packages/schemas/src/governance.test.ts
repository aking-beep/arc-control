import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DUE_SOON_DAYS, daysUntil, dueState, isFindingOpen } from './governance.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

/** A deadline `offset` milliseconds from NOW, as an ISO string. */
function at(offset: number): string {
  return new Date(NOW + offset).toISOString();
}

/**
 * These boundaries are shared by the engine, which counts findings, and the
 * console, which renders them. They lived in both places once, and drifted:
 * the console rounded to whole days before deciding, so a finding six hours
 * past its deadline rendered as "due in 0d" in the table its own overdue
 * filter had selected it for. The classification is defined here, on exact
 * milliseconds, so there is only one of it.
 */
describe('dueState', () => {
  it('has no deadline to judge when none is set', () => {
    assert.equal(dueState(undefined, NOW), 'unscheduled');
    assert.equal(dueState('', NOW), 'unscheduled');
  });

  it('says so rather than guessing when the date cannot be read', () => {
    assert.equal(dueState('not-a-date', NOW), 'unreadable');
  });

  it('is overdue the instant the deadline passes, not a day later', () => {
    assert.equal(dueState(at(-1), NOW), 'overdue', 'one millisecond late is late');
    assert.equal(dueState(at(-6 * 3_600_000), NOW), 'overdue', 'six hours late is late');
    assert.equal(dueState(at(-30 * DAY), NOW), 'overdue');
  });

  it('treats the deadline itself as not yet missed', () => {
    assert.equal(dueState(at(0), NOW), 'due_soon');
  });

  it('is due soon up to and including the horizon, and scheduled after it', () => {
    assert.equal(dueState(at(DUE_SOON_DAYS * DAY), NOW), 'due_soon', 'the horizon is inclusive');
    assert.equal(dueState(at(DUE_SOON_DAYS * DAY + 1), NOW), 'scheduled', 'and one millisecond past it is not');
  });

  /**
   * The bug in one assertion: a rounding classifier put this row in the
   * due-soon bucket while the engine counted it as overdue.
   */
  it('never classifies a late deadline as upcoming, however little it is late by', () => {
    for (const lateBy of [1, 1_000, 3_600_000, 11 * 3_600_000, 23 * 3_600_000]) {
      assert.equal(dueState(at(-lateBy), NOW), 'overdue', `${String(lateBy)}ms late`);
    }
  });
});

describe('daysUntil', () => {
  it('truncates toward zero rather than rounding away from it', () => {
    assert.equal(daysUntil(at(7 * DAY + 23 * 3_600_000), NOW), 7, 'not 8');
    assert.equal(daysUntil(at(-23 * 3_600_000), NOW), 0, 'not -1');
  });

  it('reports whole days for whole days', () => {
    assert.equal(daysUntil(at(3 * DAY), NOW), 3);
    assert.equal(daysUntil(at(-3 * DAY), NOW), -3);
  });
});

describe('isFindingOpen', () => {
  it('counts raised and in-progress work as open', () => {
    assert.equal(isFindingOpen({ status: 'open' }), true);
    assert.equal(isFindingOpen({ status: 'in_progress' }), true);
  });

  it('counts every closing route as closed, accepted risk included', () => {
    assert.equal(isFindingOpen({ status: 'resolved' }), false);
    assert.equal(isFindingOpen({ status: 'accepted' }), false);
    assert.equal(isFindingOpen({ status: 'false_positive' }), false);
  });
});
