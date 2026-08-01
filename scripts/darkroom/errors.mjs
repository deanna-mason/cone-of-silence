// All darkroom failures are a DarkroomError with a stable machine-readable
// `.code` and a human `.message` of the form "<code>: <detail>". The CLI
// (index.mjs, later) prints `darkroom: <code>: <detail>` to stderr and
// exits non-zero — nothing here decides process exit behavior.
export class DarkroomError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "DarkroomError";
    this.code = code;
  }
}
