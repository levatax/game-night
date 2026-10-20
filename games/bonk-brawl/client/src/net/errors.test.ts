import { describe, expect, it } from "vitest";
import { JOIN_ERROR, JOIN_ERROR_TEXT } from "../../../shared/protocol";
import { MESSAGES, isFinalClose, isRoomGone, toNetError } from "./errors";

/** Shapes colyseus.js rejects with (MatchMakeError / ServerError carry a numeric `code`). */
function serverError(code: number | undefined, message: string): Error & { code?: number } {
  return Object.assign(new Error(message), { code });
}

describe("toNetError", () => {
  it("maps the room's own JOIN_ERROR codes 1:1", () => {
    expect(toNetError(serverError(JOIN_ERROR.ROOM_FULL, "x"))).toEqual({ kind: "roomFull", message: JOIN_ERROR_TEXT[JOIN_ERROR.ROOM_FULL] });
    expect(toNetError(serverError(JOIN_ERROR.BAD_NICKNAME, "x")).kind).toBe("badNickname");
    expect(toNetError(serverError(JOIN_ERROR.BAD_CHARACTER, "x")).kind).toBe("badCharacter");
    expect(toNetError(serverError(JOIN_ERROR.NOT_FOUND, "x")).kind).toBe("notFound");
  });

  it("maps Colyseus 4212: locked → room full, otherwise not found", () => {
    expect(toNetError(serverError(4212, 'room "ABCD" is locked'))).toEqual({ kind: "roomFull", message: "Room full" });
    expect(toNetError(serverError(4212, 'room "ABCD" not found'))).toEqual({ kind: "notFound", message: "No room with that code" });
  });

  it("maps network failures to serverDown", () => {
    expect(toNetError(new TypeError("Failed to fetch")).kind).toBe("serverDown");
    expect(toNetError(serverError(undefined, "")).kind).toBe("serverDown");
    expect(toNetError(serverError(undefined, "NetworkError when attempting to fetch resource.")).kind).toBe("serverDown");
    expect(toNetError(serverError(1006, "")).kind).toBe("serverDown");
    expect(toNetError(serverError(503, "Service Unavailable")).kind).toBe("serverDown");
    expect(toNetError(serverError(4212, "x")).kind).not.toBe("serverDown");
  });

  it("keeps other server messages as unknown", () => {
    expect(toNetError(serverError(4216, "onJoin exploded"))).toEqual({ kind: "unknown", message: "onJoin exploded" });
    expect(toNetError(serverError(undefined, "Invalid reconnection token format"))).toEqual({
      kind: "unknown",
      message: "Invalid reconnection token format",
    });
  });

  it("treats an error with neither code nor message (a raw XHR error event) as unreachable", () => {
    expect(toNetError({ type: "error" })).toEqual({ kind: "serverDown", message: MESSAGES.serverDown });
  });

  it("passes NetErrors through", () => {
    const err = { kind: "kicked", message: "bye" } as const;
    expect(toNetError(err)).toBe(err);
  });
});

describe("close / reconnect helpers", () => {
  it("treats only normal and consented closes as final", () => {
    expect(isFinalClose(1000)).toBe(true);
    expect(isFinalClose(4000)).toBe(true);
    expect(isFinalClose(1006)).toBe(false);
    expect(isFinalClose(1001)).toBe(false);
    expect(isFinalClose(4002)).toBe(false);
  });

  it("knows when the room is gone", () => {
    expect(isRoomGone(serverError(4212, 'room "ABCD" has been disposed.'))).toBe(true);
    expect(isRoomGone(serverError(4214, "reconnection token invalid or expired."))).toBe(false);
    expect(isRoomGone(new TypeError("Failed to fetch"))).toBe(false);
  });
});
