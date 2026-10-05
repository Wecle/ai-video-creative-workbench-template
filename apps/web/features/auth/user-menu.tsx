"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Button } from "@creative/ui";
import { authClient } from "../../lib/auth-client";
import { clearAccessToken } from "../../lib/access-token";
import { authCopy as copy } from "./copy";

export function UserMenu({
  email,
  workspace,
}: {
  email?: string;
  workspace?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      // Whatever the server said, this browser must forget the user.
      clearAccessToken();
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-2">
      {email && <span className="text-xs text-neutral-400">{email}</span>}
      {workspace && (
        <span className="text-xs text-neutral-500">· {workspace}</span>
      )}
      <Button variant="outline" onClick={signOut} disabled={pending}>
        <LogOut />
        {pending ? copy.workspace.signingOut : copy.workspace.signOut}
      </Button>
    </div>
  );
}
