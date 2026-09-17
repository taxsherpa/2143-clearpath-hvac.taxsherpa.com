import { Link } from "wouter";
import type { ReactNode } from "react";

/** Shared chrome for /privacy and /terms — both are public, unauthenticated pages. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 max-w-2xl mx-auto px-6 py-12 space-y-6 w-full">
        <div>
          <Link href="/" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            &larr; Back to ClearPath Mapper
          </Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1">Last updated: {updated}</p>
        </div>
        <div className="space-y-6 text-sm leading-relaxed">{children}</div>
      </div>
      <footer className="border-t px-6 py-4 text-xs text-muted-foreground text-center">
        <Link href="/privacy" className="text-blue-600 hover:underline dark:text-blue-400">
          Privacy Policy
        </Link>
        <span className="mx-2">·</span>
        <Link href="/terms" className="text-blue-600 hover:underline dark:text-blue-400">
          Terms of Service
        </Link>
      </footer>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{title}</h2>
      <div className="text-muted-foreground space-y-3">{children}</div>
    </section>
  );
}
