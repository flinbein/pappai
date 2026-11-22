// node tests/probes/codex-oauth/probe.mjs [absolute-path-to-codex]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ageGrant, config, executor, login } from './codex.mjs';
import { mcp, oauthProvider, serve } from './fixture.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pappai-oauth-'));
const homes = Object.fromEntries(['profile', 'a', 'b', 'copy', 'control'].map(name => [name, path.join(temp, name)]));
const provider = await oauthProvider();
const shared = { url: provider.origin + '/mcp' };
const keys = { a: randomUUID(), b: randomUUID() };
let owner, a, b, copy, control;
const gateway = await serve(async (req, res, raw) => {
  const principal = req.url.slice(1);
  if (!Object.hasOwn(keys, principal) || req.headers.authorization !== 'Bearer ' + keys[principal]) {
    return res.writeHead(403).end();
  }
  await mcp(req, res, raw, () => owner.call('shared'));
});
const ready = async () => {
  owner = await executor(homes.profile);
  a = await executor(homes.a, keys.a);
  b = await executor(homes.b, keys.b);
};
const stop = async () => {
  await Promise.all([a, b, owner, copy, control].filter(Boolean).map(peer => peer.close()));
  a = b = owner = copy = control = undefined;
};
const check = async () => {
  const actual = await Promise.all([a.call('profile'), a.call('private'), b.call('profile'), b.call('private')]);
  assert.deepEqual(actual, ['team', 'alice', 'team', 'bob']);
};
try {
  await config(homes.profile, { shared });
  for (const name of ['a', 'b']) {
    await config(homes[name], { private: shared, profile: { url: gateway.origin + '/' + name, bearer: true } });
  }
  await login(homes.profile, 'shared', 'team', provider);
  await login(homes.a, 'private', 'alice', provider);
  await login(homes.b, 'private', 'bob', provider);

  // Snapshot the native profile grant before any rotation. The copy has exactly the same native name and URL.
  await config(homes.copy, { shared });
  await fs.copyFile(path.join(homes.profile, '.credentials.json'), path.join(homes.copy, '.credentials.json'));
  await config(homes.control, { private: shared });
  control = await executor(homes.control);
  assert.ok(control.status.find(row => row.name === 'private')?.toolsError, 'empty home unexpectedly authenticated');
  const denied = await fetch(gateway.origin + '/b', { headers: { authorization: 'Bearer ' + keys.a } });
  assert.equal(denied.status, 403);
  await ready();
  await check();
  await stop();

  // Codex performs its own refresh. Only the local expiry timestamp is accelerated while all writers are stopped.
  await Promise.all(['a', 'b', 'profile', 'copy'].map(name => ageGrant(homes[name])));
  await ready();
  await check();
  assert.deepEqual([...provider.counts.rotations].sort(), ['alice', 'bob', 'team']);
  copy = await executor(homes.copy);
  assert.ok(copy.status.find(row => row.name === 'shared')?.toolsError, 'stale copied grant unexpectedly usable');
  assert.ok(provider.counts.rejectedRefreshes > 0);
  await stop();
  const rejections = provider.counts.rejectedRefreshes;
  await ready();
  await check();
  assert.deepEqual(provider.counts.logins, ['team', 'alice', 'bob']);
  assert.deepEqual([...provider.counts.rotations].sort(), ['alice', 'bob', 'team']);
  assert.equal(provider.counts.rejectedRefreshes, rejections);
  assert.deepEqual([...provider.counts.calls].sort(), [...Array(3).fill('alice'), ...Array(3).fill('bob'), ...Array(6).fill('team')]);
  await stop();
  await Promise.all(['a', 'b', 'profile'].map(name => ageGrant(homes[name])));
  await ready();
  await check();
  assert.deepEqual([...provider.counts.rotations].sort(), ['alice', 'alice', 'bob', 'bob', 'team', 'team']);
  assert.equal(provider.counts.rejectedRefreshes, rejections);

  // Report the observed handling of an early 401 separately from scheduled, persisted refresh.
  provider.revokeAccess('team');
  const previousRotations = provider.counts.rotations.length;
  const previousRejections = provider.counts.rejectedRefreshes;
  const calls = await Promise.allSettled([a.call('profile'), b.call('profile')]);
  const successfulCallsAfterRevocation = calls.filter(result => result.status === 'fulfilled' && result.value === 'team').length;
  assert.equal(successfulCallsAfterRevocation, 2, 'both concurrent calls must recover after the fixture revokes the shared access token');
  assert.equal(provider.counts.rotations.length - previousRotations, 1);
  assert.equal(provider.counts.rejectedRefreshes - previousRejections, 0);
  console.log(JSON.stringify({
    passes: ['concurrent-executors', 'per-app-accounts', 'one-profile-owner', 'cross-app-gateway-denied',
      'empty-home-denied', 'native-refresh', 'stale-copy-rejected', 'rotated-grants-survive-restart', 'rotated-refresh-reused'],
    exchanges: provider.counts.logins.length, scheduledRotations: previousRotations, rejectedStaleRefreshes: rejections,
    earlyAccessRevocation: { successfulConcurrentCalls: successfulCallsAfterRevocation, total: calls.length,
      refreshes: provider.counts.rotations.length - previousRotations,
      rejectedRefreshes: provider.counts.rejectedRefreshes - previousRejections },
    authenticatedProviderToolCalls: provider.counts.calls.length, modelTurns: 0
  }));
} finally {
  await stop();
  await gateway.close();
  await provider.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
