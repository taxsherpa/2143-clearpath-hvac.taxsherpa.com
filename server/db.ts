import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Railway's Postgres plugin (2143). Plain TCP via node-postgres — the previous
// Neon serverless/WebSocket driver will not connect to a generic Postgres instance.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's public proxy hostname presents a cert that doesn't match; the
  // internal hostname needs no TLS at all. Either way, don't fail on the chain.
  ssl: /\bproxy\.rlwy\.net\b|sslmode=require/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

export const db = drizzle(pool, { schema });
