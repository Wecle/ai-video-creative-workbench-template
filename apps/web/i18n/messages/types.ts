import type { en } from "./en";

/** Widens the literal strings of the `as const` English catalog. */
type Widen<T> = T extends string
  ? string
  : { -readonly [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof en>;
export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

/** Dotted path of every string in the catalog. Node types contain dots themselves
 *  ("image.generate"), so lookups use the flattened catalog, never a split on ".". */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<typeof en>;
