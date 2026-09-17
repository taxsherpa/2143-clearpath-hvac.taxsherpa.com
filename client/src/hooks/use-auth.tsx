import { createContext, ReactNode, useContext } from "react";
import { useQuery, useMutation, UseMutationResult } from "@tanstack/react-query";
import { queryClient } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type User = {
  id: string;
  email: string;
  createdAt: Date;
};

/** A signed-in user whose paid access has ended (or not started yet). See server/auth.ts. */
export type AccessEnded = {
  email: string;
  endedAt: string | null;
  startsAt: string | null;
  purchaseUrl: string | null;
};

const ACCESS_ENDED_KEY = ["/api/user", "access-ended"];

type MagicLinkRequest = {
  email: string;
};

type VerifyRequest = {
  token: string;
};

type AuthContextType = {
  user: User | null;
  /** Set instead of `user` when the session is valid but access has ended. */
  accessEnded: AccessEnded | null;
  isLoading: boolean;
  error: Error | null;
  /** Step 1: ask for a sign-in link by email. */
  magicLinkMutation: UseMutationResult<{ message: string }, Error, MagicLinkRequest>;
  /** Step 2: exchange the emailed token for a session (fired by the transition page's button). */
  verifyMutation: UseMutationResult<User, Error, VerifyRequest>;
  logoutMutation: UseMutationResult<void, Error, void>;
};

export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();

  const {
    data: user,
    error,
    isLoading,
  } = useQuery<User | null>({
    queryKey: ["/api/user"],
    queryFn: async () => {
      const response = await fetch("/api/user");
      if (response.status === 401) {
        queryClient.setQueryData(ACCESS_ENDED_KEY, null);
        return null;
      }
      if (response.status === 403) {
        const body = await response.json();
        if (body.error === "access_expired") {
          queryClient.setQueryData<AccessEnded>(ACCESS_ENDED_KEY, {
            email: body.email,
            endedAt: body.endedAt,
            startsAt: body.startsAt,
            purchaseUrl: body.purchaseUrl,
          });
          return null;
        }
      }
      if (!response.ok) {
        throw new Error("Failed to fetch user");
      }
      return response.json();
    },
    retry: false,
  });

  // Written by the query above; never fetched on its own.
  const { data: accessEnded } = useQuery<AccessEnded | null>({
    queryKey: ACCESS_ENDED_KEY,
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });

  const magicLinkMutation = useMutation({
    mutationFn: async (payload: MagicLinkRequest) => {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not send the sign-in link");
      }
      return body as { message: string };
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't send your link",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (payload: VerifyRequest) => {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Sign-in failed");
      }
      return body as User;
    },
    onSuccess: (user: User) => {
      queryClient.setQueryData(ACCESS_ENDED_KEY, null);
      queryClient.setQueryData(["/api/user"], user);
      toast({
        title: "You're signed in",
        description: user.email,
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/logout", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Logout failed");
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/user"], null);
      queryClient.clear();
      toast({
        title: "Signed out",
        description: "You've been successfully signed out",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Sign-out failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        accessEnded: accessEnded ?? null,
        isLoading,
        error,
        magicLinkMutation,
        verifyMutation,
        logoutMutation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
