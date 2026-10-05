export type ConnectionErrorCode =
  | "unknown-node"
  | "unknown-port"
  | "port-type-mismatch"
  | "self-loop"
  | "duplicate-edge"
  | "cycle";

export type OpErrorCode =
  | ConnectionErrorCode
  | "invalid-id"
  | "duplicate-node"
  | "unknown-node-type"
  | "invalid-config"
  | "invalid-title"
  | "invalid-position"
  | "unknown-edge";

/** Operations never throw for business reasons; they return a code the UI can localize. */
export type Result<T = void, C extends string = OpErrorCode> =
  { ok: true; value: T } | { ok: false; code: C };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <C extends string>(code: C): Result<never, C> => ({
  ok: false,
  code,
});
