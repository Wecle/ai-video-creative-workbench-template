// Every user-facing string of the auth pages lives here, so that the i18n work
// planned for P1 only has to migrate this file.
export const authCopy = {
  login: {
    title: "Sign in",
    description: "Sign in to continue to Creative Workbench.",
    submit: "Sign in",
    submitting: "Signing in…",
    switchPrompt: "No account yet?",
    switchLink: "Create one",
  },
  signup: {
    title: "Create an account",
    description: "Create an account to start using Creative Workbench.",
    submit: "Create account",
    submitting: "Creating account…",
    switchPrompt: "Already have an account?",
    switchLink: "Sign in",
  },
  fields: {
    name: "Name",
    email: "Email",
    password: "Password",
  },
  validation: {
    name: "Enter your name",
    email: "Enter a valid email address",
    passwordMin: "Password must be at least 8 characters",
    passwordMax: "Password must be at most 128 characters",
  },
  google: "Continue with Google",
  or: "or",
  genericError: "Something went wrong. Please try again.",
  workspace: {
    signOut: "Sign out",
    signingOut: "Signing out…",
  },
} as const;
