import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SUBJECT_REGEX = /^[\w.@:-]{3,120}$/;
const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface SessionClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthResult {
  ok: true;
  token: string;
  expiresAt: number;
  subject: string;
}

export interface AuthError {
  ok: false;
  status: number;
  error: string;
}

interface StoredCredential {
  subject: string;
  salt: string;
  hashHex: string;
}

export class OperatorAuthStore {
  private signingKey: Buffer;
  private credential: StoredCredential | null = null;
  private revokedTokens: Map<string, number> = new Map();

  constructor() {
    this.signingKey = randomBytes(32);
  }

  isClaimed(): boolean {
    return this.credential !== null;
  }

  getClaimedSubject(): string | null {
    return this.credential ? this.credential.subject : null;
  }

  claim(subjectInput: string, passphraseInput: string): AuthResult | AuthError {
    if (this.credential !== null) {
      return {
        ok: false,
        status: 409,
        error: 'Operator passphrase is already configured. Unlock with your existing passphrase.',
      };
    }

    const subject = typeof subjectInput === 'string' ? subjectInput.trim() : '';
    if (!SUBJECT_REGEX.test(subject)) {
      return {
        ok: false,
        status: 400,
        error: 'Operator subject must be 3-120 characters (letters, digits, ., _, @, :, -).',
      };
    }

    if (typeof passphraseInput !== 'string' || passphraseInput.length < 10 || passphraseInput.length > 256) {
      return {
        ok: false,
        status: 400,
        error: 'Passphrase must be between 10 and 256 characters.',
      };
    }

    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(passphraseInput, salt, 64);
    this.credential = {
      subject,
      salt,
      hashHex: derived.toString('hex'),
    };

    return this.issueSession(subject);
  }

  login(passphraseInput: string): AuthResult | AuthError {
    if (!this.credential) {
      return {
        ok: false,
        status: 409,
        error: 'Operator passphrase is not set up yet. Complete initial setup first.',
      };
    }

    if (typeof passphraseInput !== 'string' || passphraseInput.length < 1 || passphraseInput.length > 256) {
      return {
        ok: false,
        status: 400,
        error: 'Passphrase is required.',
      };
    }

    const candidate = scryptSync(passphraseInput, this.credential.salt, 64);
    const expected = Buffer.from(this.credential.hashHex, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid operator passphrase.',
      };
    }

    return this.issueSession(this.credential.subject);
  }

  private issueSession(subject: string): AuthResult {
    const iat = Date.now();
    const exp = iat + TOKEN_TTL_MS;
    const jti = randomBytes(16).toString('hex');
    const claims: SessionClaims = { sub: subject, iat, exp, jti };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.signingKey).update(payload).digest('base64url');
    return {
      ok: true,
      token: `${payload}.${sig}`,
      expiresAt: exp,
      subject,
    };
  }

  verifyBearer(authHeader: string | undefined): SessionClaims | null {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payload, sig] = parts;
    if (!payload || !sig || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) {
      return null;
    }

    const expectedSig = createHmac('sha256', this.signingKey).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    let parsed: SessionClaims;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    } catch {
      return null;
    }

    if (
      !parsed ||
      typeof parsed.sub !== 'string' ||
      !SUBJECT_REGEX.test(parsed.sub) ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.jti !== 'string' ||
      parsed.exp <= Date.now()
    ) {
      return null;
    }

    this.pruneRevoked();
    if (this.revokedTokens.has(parsed.jti)) {
      return null;
    }

    return parsed;
  }

  revokeBearer(authHeader: string | undefined): void {
    const claims = this.verifyBearer(authHeader);
    if (claims) {
      this.revokedTokens.set(claims.jti, claims.exp);
    }
  }

  private pruneRevoked(): void {
    const now = Date.now();
    for (const [jti, exp] of this.revokedTokens.entries()) {
      if (exp <= now) {
        this.revokedTokens.delete(jti);
      }
    }
  }
}

export function isSameOriginRequest(
  headers: Record<string, string | string[] | undefined>
): boolean {
  const originRaw = headers['origin'];
  const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
  if (!origin) return true;

  const forwardedHostRaw = headers['x-forwarded-host'];
  const hostRaw = headers['host'];
  const hostHeader =
    (Array.isArray(forwardedHostRaw) ? forwardedHostRaw[0] : forwardedHostRaw) ||
    (Array.isArray(hostRaw) ? hostRaw[0] : hostRaw);

  if (!hostHeader) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host.toLowerCase() === hostHeader.split(',')[0].trim().toLowerCase();
  } catch {
    return false;
  }
}
