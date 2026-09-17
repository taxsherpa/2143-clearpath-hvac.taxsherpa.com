import { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { randomBytes, createHash } from "crypto";
import { and, eq, isNull, lt, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { users, loginTokens } from "@shared/schema";
import { sendMagicLinkEmail, sendNoAccessEmail } from "./lib/email";
import { getAccessStatus, isAccessGateEnabled, normalizeEmail, purchaseUrl } from "./lib/access";

const PostgresSessionStore = connectPg(session);

const TOKEN_TTL_MINUTES = 20;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_PER_EMAIL = 5;
const RATE_LIMIT_MAX_PER_IP = 15;

// These were previously contributed by @types/passport. Passport is gone, so the
// request-shape contract the route handlers rely on is declared here instead.
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      createdAt: Date;
    }

    interface Request {
      user?: User;
      isAuthenticated(): boolean;
      /**
       * Set when the access gate is on and this signed-in user no longer has active access.
       * The session is kept (so renewing lets them straight back in), but authenticated
       * routes answer 403 `access_expired` instead of serving data.
       */
      accessEnded?: { endedAt: Date | null; startsAt: Date | null };
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

/** In-process send throttle. Blunts email-bombing; not a distributed rate limiter. */
const sendHistory = new Map<string, number[]>();

function rateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const hits = (sendHistory.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= max) {
    sendHistory.set(key, hits);
    return true;
  }
  hits.push(now);
  sendHistory.set(key, hits);
  return false;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function appUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function publicUser(row: { id: string; email: string; createdAt: Date }) {
  return { id: row.id, email: row.email, createdAt: row.createdAt };
}

export function setupAuth(app: Express) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production.");
  }

  const sessionSettings: session.SessionOptions = {
    secret: sessionSecret || "clearpath-dev-only-secret",
    resave: false,
    saveUninitialized: false,
    store: new PostgresSessionStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    }),
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));

  // Hydrates req.user from the session and provides req.isAuthenticated(), so the
  // route handlers keep the same contract they had under Passport.
  app.use(async (req: Request, _res: Response, next: NextFunction) => {
    req.isAuthenticated = function isAuthenticated(this: Request) {
      return Boolean(this.user);
    } as typeof req.isAuthenticated;

    if (!req.session.userId) return next();

    try {
      const [row] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (row) {
        req.user = publicUser(row);
        // Checked on every request, not only at sign-in: sessions last 30 days, so a
        // sign-in-only check would let an expired grant keep working for up to a month.
        if (isAccessGateEnabled()) {
          const access = await getAccessStatus(row.email);
          if (!access.active) {
            req.accessEnded = { endedAt: access.endedAt, startsAt: access.startsAt };
          }
        }
      } else {
        // Account no longer exists — drop the stale session rather than 500 later.
        delete req.session.userId;
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  /**
   * Step 1 — request a link.
   * Always answers 200 with the same body: whether an address has an account is not
   * something an unauthenticated caller gets to enumerate. A brand-new address is
   * fine; the account is created on first successful verification.
   *
   * With the access gate on, an address without active access gets an explanatory email
   * instead of a link — and still the same 200, so access is only ever disclosed to the
   * address's own inbox.
   */
  app.post("/api/auth/magic-link", async (req, res) => {
    const generic = { ok: true, message: "If that email is valid, a sign-in link is on its way." };
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const ip = req.ip || "unknown";
    if (rateLimited(`email:${email}`, RATE_LIMIT_MAX_PER_EMAIL) || rateLimited(`ip:${ip}`, RATE_LIMIT_MAX_PER_IP)) {
      return res.status(429).json({ error: "Too many sign-in requests. Try again in a few minutes." });
    }

    try {
      if (isAccessGateEnabled()) {
        const access = await getAccessStatus(email);
        if (!access.active) {
          await sendNoAccessEmail({
            to: email,
            endedAt: access.endedAt,
            startsAt: access.startsAt,
            purchaseUrl: purchaseUrl(),
          });
          return res.json(generic);
        }
      }

      // Clear this address's outstanding links: requesting a new one invalidates the
      // old, so only the newest email in the inbox works.
      await db.delete(loginTokens).where(and(eq(loginTokens.email, email), isNull(loginTokens.consumedAt)));
      // Opportunistic cleanup of anything long expired.
      await db.delete(loginTokens).where(lt(loginTokens.expiresAt, sql`now() - interval '7 days'`));

      const token = randomBytes(32).toString("hex");
      await db.insert(loginTokens).values({
        email,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000),
        requestedIp: ip,
      });

      const verifyUrl = `${appUrl(req)}/verify?token=${token}`;
      await sendMagicLinkEmail({ to: email, verifyUrl, expiresInMinutes: TOKEN_TTL_MINUTES });

      res.json(generic);
    } catch (error: any) {
      console.error("Magic-link send failed:", error?.message ?? error);
      res.status(500).json({ error: "Could not send the sign-in link. Please try again." });
    }
  });

  /**
   * Step 2 — consume the token.
   * POST-only, and never triggered by merely loading the transition page, so an email
   * scanner pre-fetching the GET link cannot burn the token.
   */
  app.post("/api/auth/verify", async (req, res, next) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      return res.status(400).json({ error: "This sign-in link is missing its token." });
    }

    try {
      // Claim the token atomically: only an unconsumed, unexpired row is updated, so
      // two concurrent clicks can never both succeed.
      const [claimed] = await db
        .update(loginTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(loginTokens.tokenHash, hashToken(token)),
            isNull(loginTokens.consumedAt),
            gt(loginTokens.expiresAt, new Date()),
          ),
        )
        .returning();

      if (!claimed) {
        return res
          .status(401)
          .json({ error: "This sign-in link has expired or was already used. Request a new one." });
      }

      // Checked again here, not just when the link was requested: a link sent while access
      // was active can be clicked after it ended (or after a refund revoked it).
      if (isAccessGateEnabled()) {
        const access = await getAccessStatus(claimed.email);
        if (!access.active) {
          return res.status(403).json({
            error: "This email doesn't have active ClearPath Mapper access.",
            code: "access_expired",
          });
        }
      }

      // First successful click on a new address creates the account — there is no
      // separate registration step in a passwordless flow.
      let [account] = await db.select().from(users).where(eq(users.email, claimed.email));
      if (!account) {
        [account] = await db.insert(users).values({ email: claimed.email }).returning();
      }
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, account.id));

      // New session id on privilege change — no session fixation.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = account.id;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.json(publicUser(account));
        });
      });
    } catch (error: any) {
      console.error("Magic-link verify failed:", error?.message ?? error);
      res.status(500).json({ error: "Could not complete sign-in. Please request a new link." });
    }
  });

  app.post("/api/logout", (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("connect.sid");
      res.sendStatus(200);
    });
  });

  /** Lets the sign-in page word itself for an open vs. a paid-access app. */
  app.get("/api/auth/config", (_req, res) => {
    res.json({ accessGateEnabled: isAccessGateEnabled(), purchaseUrl: purchaseUrl() });
  });

  app.get("/api/user", (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (req.accessEnded) {
      return res.status(403).json({
        error: "access_expired",
        email: req.user.email,
        endedAt: req.accessEnded.endedAt,
        startsAt: req.accessEnded.startsAt,
        purchaseUrl: purchaseUrl(),
      });
    }
    res.json(req.user);
  });
}
