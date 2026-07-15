import { describe } from "vitest";
import { accountStoreContract } from "./accountStoreContract.js";
import { FakeAccountStore } from "./fakes.js";

describe("FakeAccountStore (contract)", () => {
  accountStoreContract(async () => new FakeAccountStore());
});
