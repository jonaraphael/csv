// src/types/font-list.d.ts
declare module 'font-list' {
  /** Returns the list of installed font family names. */
  export function getFonts(): Promise<string[]>;
}
