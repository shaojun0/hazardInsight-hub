import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  appBaseUrl: string;
  sessionSecret: string;
  secureCookies: boolean;
}

interface PendingAuthorization { verifier: string; expiresAt: number }
interface SessionRecord { user: AuthUser; accessToken: string; expiresAt: number }

const OAUTH_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

export class GithubOAuthService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    readonly config: GithubOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  createAuthorization(): { url: string; state: string } {
    this.prune();
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, expiresAt: Date.now() + OAUTH_TTL_MS });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: 'read:user',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `https://github.com/login/oauth/authorize?${query}`, state };
  }

  async completeAuthorization(code: string, state: string, cookieState: string | undefined): Promise<{ sessionCookie: string; user: AuthUser }> {
    this.prune();
    if (!cookieState || !safeEqual(state, cookieState)) throw new AuthError('登录状态校验失败，请重新登录。', 'OAUTH_STATE_MISMATCH', 400);
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) throw new AuthError('登录请求已过期，请重新登录。', 'OAUTH_STATE_EXPIRED', 400);

    const tokenResponse = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'nuclear-hazard-demo' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
        code_verifier: pending.verifier,
      }),
    });
    const tokenData = await tokenResponse.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new AuthError(tokenData.error_description ?? 'GitHub 授权码交换失败。', tokenData.error ?? 'OAUTH_TOKEN_FAILED', 502);
    }

    const userResponse = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenData.access_token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nuclear-hazard-demo',
      },
    });
    const githubUser = await userResponse.json().catch(() => ({})) as {
      id?: number; login?: string; name?: string | null; avatar_url?: string; html_url?: string; message?: string;
    };
    if (!userResponse.ok || !githubUser.id || !githubUser.login) {
      throw new AuthError(githubUser.message ?? '无法读取 GitHub 用户信息。', 'GITHUB_USER_FAILED', 502);
    }
    const user: AuthUser = {
      id: githubUser.id,
      login: githubUser.login,
      name: githubUser.name ?? null,
      avatarUrl: githubUser.avatar_url ?? '',
      profileUrl: githubUser.html_url ?? `https://github.com/${githubUser.login}`,
    };
    const sessionId = randomToken(32);
    this.sessions.set(sessionId, { user, accessToken: tokenData.access_token, expiresAt: Date.now() + SESSION_TTL_MS });
    return { sessionCookie: this.sign(sessionId), user };
  }

  getUser(signedSession: string | undefined): AuthUser | null {
    if (!signedSession) return null;
    const sessionId = this.verify(signedSession);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session.user;
  }

  logout(signedSession: string | undefined): void {
    const sessionId = signedSession ? this.verify(signedSession) : null;
    if (sessionId) this.sessions.delete(sessionId);
  }

  private sign(value: string): string {
    const signature = createHmac('sha256', this.config.sessionSecret).update(value).digest('base64url');
    return `${value}.${signature}`;
  }

  private verify(value: string): string | null {
    const dot = value.lastIndexOf('.');
    if (dot < 1) return null;
    const raw = value.slice(0, dot);
    const expected = this.sign(raw);
    return safeEqual(value, expected) ? raw : null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
  }
}

export class AuthError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export function githubOAuthConfigFromEnv(): GithubOAuthConfig | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const appBaseUrl = (process.env.APP_BASE_URL?.trim() || 'http://localhost:5175').replace(/\/$/, '');
  const callbackUrl = process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() || `${appBaseUrl}/api/auth/github/callback`;
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('启用 GitHub OAuth 时 SESSION_SECRET 必须至少为 32 个字符。');
  }
  return {
    clientId,
    clientSecret,
    callbackUrl,
    appBaseUrl,
    sessionSecret,
    secureCookies: process.env.NODE_ENV === 'production' || appBaseUrl.startsWith('https://'),
  };
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
