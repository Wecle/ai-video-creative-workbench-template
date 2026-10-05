import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Only checks that a session cookie exists; this is a convenience redirect, not a
// security boundary. Real authorization happens in the gateway and the backend.
export function middleware(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!login(?:/|$)|signup(?:/|$)|api/auth(?:/|$)|gateway(?:/|$)|_next/static|_next/image|favicon.ico).*)",
  ],
};
