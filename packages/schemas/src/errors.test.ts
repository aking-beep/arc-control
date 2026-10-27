import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError, isArcError, toArcError, type ArcErrorCode } from './errors.js';

const ALL_CODES: readonly ArcErrorCode[] = [
  'unauthenticated',
  'agent_suspended',
  'unknown_tool',
  'invalid_parameters',
  'policy_denied',
  'approval_required',
  'approval_expired',
  'approval_rejected',
  'execution_failed',
  'connector_unavailable',
  'not_found',
  'conflict',
  'invalid_request',
  'internal',
];

describe('ArcError status mapping', () => {
  it('never reports a success status on an error path', () => {
    // An ArcError is always a refusal or a failure. A 2xx here would make a
    // caller branching on `response.ok` read a refusal as a success — which is
    // exactly what `approval_required` did when it mapped to 202, so that
    // someone releasing an action nobody had approved got "Accepted".
    for (const code of ALL_CODES) {
      const status = new ArcError(code, 'test').httpStatus;
      assert.ok(
        status >= 400 && status < 600,
        `${code} maps to ${status}; an error must map to a 4xx or 5xx`,
      );
    }
  });

  it('maps each code to the status its meaning implies', () => {
    const expected: Record<ArcErrorCode, number> = {
      unauthenticated: 401,
      agent_suspended: 403,
      unknown_tool: 404,
      // 403 rather than 404: the tool exists and ARC is refusing to run it.
      // An agent needs to tell "you may not" from "no such thing", not least
      // because the first usually means an operator has just hit a switch.
      tool_disabled: 403,
      rate_limited: 429,
      invalid_parameters: 400,
      policy_denied: 403,
      approval_required: 409,
      approval_expired: 409,
      approval_rejected: 403,
      execution_failed: 502,
      connector_unavailable: 503,
      // An outage, not a credential problem: ARC could not ask the provider
      // who someone is. 503 so a load balancer and an on-call rota treat it
      // as the infrastructure failure it is, rather than as a user error.
      identity_provider_unavailable: 503,
      // A configured gate refused the request as submitted: well-formed, not acceptable.
      gate_refused: 422,
      not_found: 404,
      conflict: 409,
      invalid_request: 400,
      internal: 500,
    };

    for (const code of ALL_CODES) {
      assert.equal(new ArcError(code, 'test').httpStatus, expected[code], code);
    }
  });

  it('covers every code in the union', () => {
    // If a code is added without a status, the lookup yields undefined and
    // the API would respond with an invalid status.
    for (const code of ALL_CODES) {
      assert.equal(typeof new ArcError(code, 'test').httpStatus, 'number', code);
    }
  });
});

describe('ArcError shape', () => {
  it('serializes to the API error envelope', () => {
    const error = new ArcError('policy_denied', 'exceeds autonomous refund authority', {
      details: { policyId: 'FINANCE-004' },
    });

    assert.deepEqual(error.toJSON(), {
      error: {
        code: 'policy_denied',
        message: 'exceeds autonomous refund authority',
        details: { policyId: 'FINANCE-004' },
      },
    });
  });

  it('defaults details to an empty object rather than undefined', () => {
    assert.deepEqual(new ArcError('internal', 'x').details, {});
  });

  it('recognizes its own instances', () => {
    assert.equal(isArcError(new ArcError('internal', 'x')), true);
    assert.equal(isArcError(new Error('x')), false);
    assert.equal(isArcError('internal'), false);
  });
});

describe('toArcError', () => {
  it('passes an ArcError through unchanged', () => {
    const original = new ArcError('not_found', 'missing');
    assert.equal(toArcError(original), original);
  });

  it('wraps a thrown Error, keeping its message and cause', () => {
    const cause = new Error('connector exploded');
    const wrapped = toArcError(cause);
    assert.equal(wrapped.code, 'internal');
    assert.equal(wrapped.message, 'connector exploded');
    assert.equal(wrapped.cause, cause);
  });

  it('wraps a thrown non-Error', () => {
    assert.equal(toArcError('just a string').message, 'just a string');
  });

  it('honours a caller-supplied fallback code', () => {
    assert.equal(toArcError(new Error('bad input'), 'invalid_request').code, 'invalid_request');
  });
});
