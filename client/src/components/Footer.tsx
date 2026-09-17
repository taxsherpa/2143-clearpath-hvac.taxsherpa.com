import { Link } from "wouter";

/**
 * Legal footer required on every page of both subdomains (Phase 4.1). Rendered inside the app
 * shell for signed-in routes, and standalone on the auth/verify/legal pages that sit outside it.
 */
export function Footer() {
  return (
    <footer className="border-t px-6 py-4 text-xs text-muted-foreground">
      <Link href="/privacy" className="text-blue-600 hover:underline dark:text-blue-400">
        Privacy Policy
      </Link>
      <span className="mx-2">·</span>
      <Link href="/terms" className="text-blue-600 hover:underline dark:text-blue-400">
        Terms of Service
      </Link>
    </footer>
  );
}
