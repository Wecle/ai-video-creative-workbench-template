import { createApiClient } from "@creative/api-client";
import { clearAccessToken, getAccessToken } from "./access-token";

function redirectToLogin() {
  clearAccessToken();
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login" || pathname === "/signup") return;
  window.location.assign(
    `/login?next=${encodeURIComponent(pathname + search)}`,
  );
}

export const api = createApiClient(
  "/gateway",
  (input, init) => fetch(input, init),
  {
    getToken: getAccessToken,
    onUnauthorized: redirectToLogin,
  },
);
