import { createAuthClient } from "better-auth/react";
import { jwtClient } from "better-auth/client/plugins";

// No baseURL: requests go to the same origin (/api/auth/*), which Next rewrites
// to the gateway. The session cookie therefore lives on the web origin.
export const authClient = createAuthClient({ plugins: [jwtClient()] });
