import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { recordingStoreContract } from "./recordingStoreContract.js";
import { FakeRecordingStore } from "./fakes.js";

describe("FakeRecordingStore (contract)", () => {
  recordingStoreContract(async () => new FakeRecordingStore(), [randomUUID(), randomUUID()]);
});
