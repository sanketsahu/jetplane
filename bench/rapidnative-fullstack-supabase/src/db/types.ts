/**
 * Database types — GENERATED. Do not edit by hand.
 *
 * Regenerated from the applied migrations (the `supabase gen types typescript` equivalent), so it
 * always matches what is actually in the database. Editing it here would silently drift the moment
 * the next migration runs.
 *
 * Empty until the first migration creates a table.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
