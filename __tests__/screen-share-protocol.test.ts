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

  // Whether THIS share carries sound. A re-share rides a parked audio
  // sender, so the far side's stream can hold an audio track that carries
  // nothing — track presence alone can't answer this.
  it("share: carries whether this share has audio", () => {
    expect(parseScreenMsg(buildScreenShareMsg("s1", true))).toEqual({ t: "scr/share", streamId: "s1", audio: true });
    expect(parseScreenMsg(buildScreenShareMsg("s1", false))).toEqual({ t: "scr/share", streamId: "s1", audio: false });
  });

  it("share from a peer that predates the flag parses with audio unknown (absent)", () => {
    expect(parseScreenMsg(JSON.stringify({ t: "scr/share", v: 1, streamId: "s1" }))).toEqual({
      t: "scr/share",
      streamId: "s1",
    });
  });

  it("a non-boolean audio flag is dropped, not trusted", () => {
    expect(parseScreenMsg(JSON.stringify({ t: "scr/share", v: 1, streamId: "s1", audio: "yes" }))).toEqual({
      t: "scr/share",
      streamId: "s1",
    });
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
