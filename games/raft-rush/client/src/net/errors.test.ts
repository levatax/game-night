// NetError mapping tests. Owner: client-net. Adapted from games/bonk-brawl/client/src/net/errors.test.ts
// (messages are i18n keys under `menu.` here).

import { describe, expect, it } from "vitest";
import { CLOSE_CODE, JOIN_ERROR } from "../../../shared/protocol";
import { ERROR_KEYS, finalCloseError, isFinalClose, isOutdated, isRoomGone, netError, toNetError } from "./errors";

/** Shapes colyseus.js rejects with (MatchMakeError / ServerError carry a numeric `code`). */
function serverError(code: number | undefined, message: string): Error & { code?: number } {
  return Object.assign(new Error(message), { code });
}

describe("toNetError", () => {
  it("maps the room's own JOIN_ERROR codes 1:1", () => {
    expect(toNetError(serverError(JOIN_ERROR.ROOM_FULL, "x"))).toEqual({ kind: "roomFull", message: "menu.errRoomFull" });
    expect(toNetError(serverError(JOIN_ERROR.BAD_NICKNAME, "x"))).toEqual({ kind: "badNickname", message: "menu.errBadNickname" });
    expect(toNetError(serverError(JOIN_ERROR.BAD_CHARACTER, "x"))).toEqual({ kind: "badCharacter", message: "menu.errBadCharacter" });
    expect(toNetError(serverError(JOIN_ERROR.NOT_FOUND, "x"))).toEqual({ kind: "notFound", message: "menu.errNotFound" });
    expect(toNetError(serverError(JOIN_ERROR.SERVER_BUSY, "x"))).toEqual({ kind: "serverBusy", message: "menu.errServerBusy" });
    expect(toNetError(serverError(JOIN_ERROR.OUTDATED, "x"))).toEqual({ kind: "outdated", message: "menu.errOutdated" });
  });

  it("maps Colyseus 4212: locked → room full, otherwise not found", () => {
    expect(toNetError(serverError(4212, 'room "ABCD" is locked'))).toEqual({ kind: "roomFull", message: "menu.errRoomFull" });
    expect(toNetError(serverError(4212, 'room "ABCD" not found'))).toEqual({ kind: "notFound", message: "menu.errNotFound" });
  });

  it("maps network failures to serverDown", () => {
    expect(toNetError(new TypeError("Failed to fetch")).kind).toBe("serverDown");
    expect(toNetError(serverError(undefined, "")).kind).toBe("serverDown");
    expect(toNetError(serverError(undefined, "NetworkError when attempting to fetch resource.")).kind).toBe("serverDown");
    expect(toNetError(serverError(1006, "")).kind).toBe("serverDown");
    expect(toNetError(serverError(503, "Service Unavailable")).kind).toBe("serverDown");
    expect(toNetError(serverError(4212, "x")).kind).not.toBe("serverDown");
  });

  it("turns other server messages into the generic unknown key (never raw text)", () => {
    expect(toNetError(serverError(4216, "onJoin exploded"))).toEqual({ kind: "unknown", message: "menu.errUnknown" });
    expect(toNetError(serverError(undefined, "Invalid reconnection token format"))).toEqual({ kind: "unknown", message: "menu.errUnknown" });
  });

  it("treats an error with neither code nor message (a raw XHR error event) as unreachable", () => {
    expect(toNetError({ type: "error" })).toEqual({ kind: "serverDown", message: "menu.errServerDown" });
  });

  it("passes NetErrors through", () => {
    const err = netError("kicked");
    expect(toNetError(err)).toBe(err);
    expect(err.message).toBe("menu.errKicked");
  });

  it("uses one menu.err* key per kind (ARCHITECTURE §7)", () => {
    expect(Object.values(ERROR_KEYS).every((k) => /^menu\.err[A-Z]\w+$/.test(k))).toBe(true);
    expect(new Set(Object.values(ERROR_KEYS)).size).toBe(Object.keys(ERROR_KEYS).length);
  });
});

describe("close / reconnect helpers", () => {
  it("treats only the consented close (4000) as final: 1000 comes from proxies too", () => {
    expect(isFinalClose(4000)).toBe(true);
    expect(isFinalClose(1000)).toBe(false);
    expect(isFinalClose(1006)).toBe(false);
    expect(isFinalClose(1001)).toBe(false);
    expect(isFinalClose(CLOSE_CODE.SERVER_RESTART)).toBe(true);
    expect(isFinalClose(4001)).toBe(false);
  });

  it("names a final close: the server restarting, else the room sending us away", () => {
    expect(finalCloseError(CLOSE_CODE.SERVER_RESTART)).toEqual({ kind: "serverRestart", message: "menu.errServerRestart" });
    expect(finalCloseError(4000)).toEqual({ kind: "kicked", message: "menu.errKicked" });
  });

  it("knows an outdated client (the room's OUTDATED code or Net's own welcome check)", () => {
    expect(isOutdated(serverError(JOIN_ERROR.OUTDATED, "The game was updated, reload the page"))).toBe(true);
    expect(isOutdated(netError("outdated"))).toBe(true);
    expect(isOutdated(serverError(JOIN_ERROR.SERVER_BUSY, "x"))).toBe(false);
    expect(isOutdated(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("knows when the room is gone", () => {
    expect(isRoomGone(serverError(4212, 'room "ABCD" has been disposed.'))).toBe(true);
    expect(isRoomGone(serverError(4214, "reconnection token invalid or expired."))).toBe(false);
    expect(isRoomGone(new TypeError("Failed to fetch"))).toBe(false);
  });
});
