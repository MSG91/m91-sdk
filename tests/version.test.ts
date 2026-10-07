/** The exported VERSION must match what npm actually publishes. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VERSION } from '../src/index.js';

test('VERSION matches package.json', () => {
  // Two levels up because tests run compiled, from dist/tests/.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    VERSION,
    pkg.version,
    `src/index.ts says ${VERSION}, package.json says ${pkg.version} — bump both`,
  );
});
