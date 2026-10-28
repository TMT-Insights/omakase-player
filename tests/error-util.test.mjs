import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {parseErrorMessage, zodErrorMapOverload} from '../src/util/error-util.ts';

test('formats Zod issues as a single error message', () => {
  const result = z.object({name: z.string(), duration: z.number()}).safeParse({name: 1, duration: 'invalid'});

  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 2);
  assert.equal(parseErrorMessage(result.error), result.error.issues.map((issue) => issue.message).join('. '));
});

test('preserves custom validation messages', () => {
  for (const value of [-1, 'invalid']) {
    assert.throws(() => z.coerce.number().min(0).parse(value, zodErrorMapOverload('Invalid duration')), (error) => {
      assert.equal(parseErrorMessage(error), 'Invalid duration');
      return true;
    });
  }
});

test('preserves successful coercion with a custom error map', () => {
  assert.equal(z.coerce.number().min(0).parse('10', zodErrorMapOverload('Invalid duration')), 10);
  assert.equal(z.coerce.boolean().parse(false, zodErrorMapOverload('Invalid dropFrame')), false);
});

test('formats non-validation errors', () => {
  assert.equal(parseErrorMessage('An error'), 'An error');
  assert.equal(parseErrorMessage(new Error('An error')), 'An error');
  assert.equal(parseErrorMessage(undefined), 'Unexpected error');
  assert.equal(parseErrorMessage({}), 'Unexpected error');
});
