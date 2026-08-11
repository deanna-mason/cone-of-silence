// Screen-share announce protocol (lib/webrtc/screenShare.ts): the cos-channel
// messages that tell the far side WHICH incoming MediaStream is a shared
// screen (stream ids survive the SDP msid; track kinds alone can't tell a
// screen from a second camera). Same "t"-prefix + reject-garbage stance as
// takeProtocol/xferProtocol.
import { describe, expect, it } from "vitest";
import { buildScreenShareMsg, buildScreenStopMsg, parseScreenMsg } from "@/lib/webrtc/screenShare";

describe("parseScreenMsg round-trips", () => {
  it("share: carries the announced stream id", () => {
    const msg = parseScreenMsg(buildScreenShareMsg("stream-abc-123"));
    expect(msg).toEqual({ t: "scr/share", streamId: "stream-abc-123" });
  });

  it("stop: no payload beyond the type", () => {
    expect(parseScreenMsg(buildScreenStopMsg())).toEqual({ t: "scr/stop" });
  });
});

describe("parseScreenMsg rejects foreign and malformed input", () => {
  it.each([
    ["another protocol's message", JSON.stringify({ t: "pod/hello", codename: "KESTREL" })],
    ["unparseable JSON", "{nope"],
    ["a bare string", JSON.stringify("scr/share")],
    ["an unknown scr/* type", JSON.stringify({ t: "scr/wave" })],
    ["share without a streamId", JSON.stringify({ t: "scr/share" })],
    ["share with a non-string streamId", JSON.stringify({ t: "scr/share", streamId: 7 })],
  ])("%s → null", (_name, raw) => {
    expect(parseScreenMsg(raw)).toBeNull();
  });
});
