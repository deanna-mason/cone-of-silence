import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreUnavailableError } from "../tokens/types.js";
import type { Recording, RecordingStatus, RecordingStore } from "./types.js";

interface RecordingRow {
  id: string;
  user_id: string;
  original_name: string;
  source_ext: string;
  status: RecordingStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    userId: row.user_id,
    originalName: row.original_name,
    sourceExt: row.source_ext,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseRecordingStore implements RecordingStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(context: string, message: string): never {
    throw new StoreUnavailableError(`${context}: ${message}`);
  }

  async create(userId: string, originalName: string, sourceExt: string): Promise<Recording> {
    const { data, error } = await this.db
      .from("recordings")
      .insert({ user_id: userId, original_name: originalName, source_ext: sourceExt })
      .select()
      .single<RecordingRow>();
    if (error) this.fail("create", error.message);
    if (!data) this.fail("create", "no row returned");
    return rowToRecording(data);
  }

  async listByUser(userId: string): Promise<Recording[]> {
    const { data, error } = await this.db
      .from("recordings")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .returns<RecordingRow[]>();
    if (error) this.fail("listByUser", error.message);
    return (data ?? []).map(rowToRecording);
  }

  async get(id: string): Promise<Recording | null> {
    const { data, error } = await this.db
      .from("recordings")
      .select("*")
      .eq("id", id)
      .maybeSingle<RecordingRow>();
    if (error) this.fail("get", error.message);
    return data ? rowToRecording(data) : null;
  }

  async setStatus(id: string, status: RecordingStatus, error: string | null = null): Promise<void> {
    const { error: updErr } = await this.db
      .from("recordings")
      .update({ status, error })
      .eq("id", id);
    if (updErr) this.fail("setStatus", updErr.message);
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.db.from("recordings").delete().eq("id", id);
    if (error) this.fail("remove", error.message);
  }

  async claimNextQueued(): Promise<Recording | null> {
    const { data: next, error } = await this.db
      .from("recordings")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<RecordingRow>();
    if (error) this.fail("claimNextQueued", error.message);
    if (!next) return null;
    const { data: won, error: updErr } = await this.db
      .from("recordings")
      .update({ status: "processing" })
      .eq("id", next.id)
      .eq("status", "queued") // only if still queued
      .select()
      .maybeSingle<RecordingRow>();
    if (updErr) this.fail("claimNextQueued", updErr.message);
    return won ? rowToRecording(won) : null;
  }

  async recoverStale(): Promise<void> {
    const { error } = await this.db
      .from("recordings")
      .update({ status: "queued" })
      .eq("status", "processing");
    if (error) this.fail("recoverStale", error.message);
  }
}
