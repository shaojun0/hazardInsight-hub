import { Router, type NextFunction, type Request, type Response } from 'express';
import { AuthError, GithubOAuthService, githubOAuthConfigFromEnv, type GithubOAuthConfig } from '../auth/github-oauth.js';

const STATE_COOKIE = 'github_oauth_state';
const SESSION_COOKIE = 'hazard_session';

export interface AuthRuntime {
  config: GithubOAuthConfig | null;
  oauth: GithubOAuthService | null;
}

export interface AuthOptions {
  config?: GithubOAuthConfig | null;
  fetchImpl?: typeof fetch;
}

export function createAuthRuntime(options?: AuthOptions): AuthRuntime {
  const config = options && 'config' in options ? options.config ?? null : githubOAuthConfigFromEnv();
  return { config, oauth: config ? new GithubOAuthService(config, options?.fetchImpl) : null };
}

export function createAuthRoutes(options?: AuthOptions & { runtime?: AuthRuntime }): Router {
  const router = Router();
  const runtime = options?.runtime ?? createAuthRuntime(options);
  const { config, oauth } = runtime;

  router.get('/auth/config', (_req, res) => {
    res.json({ data: { github: { enabled: Boolean(oauth) } } });
  });

  router.get('/auth/session', (req, res) => {
    const user = oauth?.getUser(readCookie(req, SESSION_COOKIE)) ?? null;
    res.json({ data: { authenticated: Boolean(user), user } });
  });

  router.get('/auth/github', (_req, res) => {
    if (!oauth || !config) {
      res.status(503).json({ error: 'GitHub OAuth 尚未配置。', code: 'GITHUB_OAUTH_NOT_CONFIGURED' });
      return;
    }
    const authorization = oauth.createAuthorization();
    res.cookie(STATE_COOKIE, authorization.state, cookieOptions(config, 10 * 60_000));
    res.redirect(302, authorization.url);
  });

  router.get('/auth/github/callback', async (req, res) => {
    if (!oauth || !config) {
      res.status(503).send('GitHub OAuth 尚未配置。');
      return;
    }
    const code = singleQuery(req.query.code);
    const state = singleQuery(req.query.state);
    const providerError = singleQuery(req.query.error);
    if (providerError) {
      redirectResult(res, config.appBaseUrl, 'denied');
      return;
    }
    if (!code || !state) {
      redirectResult(res, config.appBaseUrl, 'invalid_callback');
      return;
    }
    try {
      const result = await oauth.completeAuthorization(code, state, readCookie(req, STATE_COOKIE));
      res.clearCookie(STATE_COOKIE, cookieOptions(config));
      res.cookie(SESSION_COOKIE, result.sessionCookie, cookieOptions(config, 8 * 60 * 60_000));
      redirectResult(res, config.appBaseUrl, 'success');
    } catch (error) {
      res.clearCookie(STATE_COOKIE, cookieOptions(config));
      const codeValue = error instanceof AuthError ? error.code.toLowerCase() : 'failed';
      redirectResult(res, config.appBaseUrl, codeValue);
    }
  });

  router.post('/auth/logout', (req, res) => {
    oauth?.logout(readCookie(req, SESSION_COOKIE));
    if (config) res.clearCookie(SESSION_COOKIE, cookieOptions(config));
    res.json({ data: { authenticated: false, user: null } });
  });

  return router;
}

/** 除登录相关端点外，所有业务 API 都必须持有有效的服务端会话。 */
export function requireAuthenticated(runtime: AuthRuntime) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!runtime.oauth) {
      res.status(503).json({ error: '登录服务尚未配置。', code: 'AUTH_NOT_CONFIGURED' });
      return;
    }
    const user = runtime.oauth.getUser(readCookie(req, SESSION_COOKIE));
    if (!user) {
      res.status(401).json({ error: '请先登录后再使用系统。', code: 'AUTH_REQUIRED' });
      return;
    }
    res.locals.authUser = user;
    next();
  };
}

function cookieOptions(config: GithubOAuthConfig, maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

function singleQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function redirectResult(res: Response, appBaseUrl: string, result: string): void {
  const url = new URL(appBaseUrl);
  url.searchParams.set('auth', result);
  url.hash = '/';
  res.redirect(302, url.toString());
}
