import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { GithubOAuthService, type GithubOAuthConfig } from '../../server/auth/github-oauth.js';
import { createAuthRoutes, createAuthRuntime, requireAuthenticated } from '../../server/http/auth.routes.js';

const config: GithubOAuthConfig = {
  clientId: 'client_test',
  clientSecret: 'secret_test',
  callbackUrl: 'http://localhost:5175/api/auth/github/callback',
  appBaseUrl: 'http://localhost:5175',
  sessionSecret: 'test-session-secret-at-least-32-characters',
  secureCookies: false,
};

test('GitHub OAuth uses state and PKCE, then creates a signed server session', async () => {
  let tokenRequest: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/login/oauth/access_token')) {
      tokenRequest = JSON.parse(String(init?.body));
      return Response.json({ access_token: 'github_access_token', token_type: 'bearer', scope: 'read:user' });
    }
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, 'Bearer github_access_token');
    return Response.json({ id: 42, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.example/octocat', html_url: 'https://github.com/octocat' });
  };
  const service = new GithubOAuthService(config, fetchImpl);
  const authorization = service.createAuthorization();
  const authUrl = new URL(authorization.url);

  assert.equal(authUrl.origin, 'https://github.com');
  assert.equal(authUrl.searchParams.get('state'), authorization.state);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.equal(authUrl.searchParams.get('scope'), 'read:user');

  const result = await service.completeAuthorization('temporary_code', authorization.state, authorization.state);
  assert.equal(result.user.id, 42);
  assert.equal(result.user.login, 'octocat');
  assert.equal(service.getUser(result.sessionCookie)?.login, 'octocat');
  assert.equal(tokenRequest.code, 'temporary_code');
  assert.ok(tokenRequest.code_verifier);
  assert.equal(JSON.stringify(tokenRequest).includes('github_access_token'), false);

  assert.equal(service.getUser(`${result.sessionCookie}tampered`), null);
  service.logout(result.sessionCookie);
  assert.equal(service.getUser(result.sessionCookie), null);
});

test('GitHub OAuth rejects a callback whose browser state does not match', async () => {
  const service = new GithubOAuthService(config, async () => { throw new Error('must not call GitHub'); });
  const authorization = service.createAuthorization();
  await assert.rejects(
    service.completeAuthorization('temporary_code', authorization.state, 'different-state'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'OAUTH_STATE_MISMATCH'
  );
});

test('auth endpoints remain public while business APIs require a valid session', async () => {
  const runtime = createAuthRuntime({ config, fetchImpl: async () => { throw new Error('must not call GitHub'); } });
  const app = express();
  app.use('/api', createAuthRoutes({ runtime }));
  app.use('/api', requireAuthenticated(runtime));
  app.get('/api/private', (_req, res) => res.json({ data: 'protected' }));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json() as { data: { authenticated: boolean } }).data.authenticated, false);

    const protectedResponse = await fetch(`${baseUrl}/api/private`);
    assert.equal(protectedResponse.status, 401);
    assert.equal((await protectedResponse.json() as { code: string }).code, 'AUTH_REQUIRED');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
