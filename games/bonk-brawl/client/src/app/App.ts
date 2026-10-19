// Boot + screen state machine. Owner: client-app.

/**
 * App owns every long-lived object and the requestAnimationFrame loop:
 *   settings (app/settings.ts), Renderer(#game), Ui(#ui), AudioEngine, Net, Input(#game),
 *   CameraRig(renderer.camera), Characters(renderer.scene), Fx(renderer.scene),
 *   MenuScene(renderer, createMenuCrowd), CharacterPreview(ui.previewCanvas), GameController.
 *
 * Boot (start()):
 *  1. Apply settings to renderer quality, audio volumes, input sensitivity/invert, camera FOV;
 *     subscribe to settings.onChange for live updates.
 *  2. Unlock audio on the first pointerdown/keydown anywhere.
 *  3. If sessionStorage has a reconnection token → screen "connecting" ("Reconnecting…"),
 *     net.tryReconnect(). Otherwise / on failure → "home". Deep link ?room=CODE (validated
 *     against CODE_PATTERN): prefill the code; if a nickname is saved, auto-join.
 *  4. Start the rAF loop: MenuScene.update while on home/lobby, GameController.frame while in game.
 *
 * Screen state machine (driven by net events, never by timers):
 *   no room                        → "home"     (MenuScene, music "lobby")
 *   create/join in flight          → "connecting"
 *   phase lobby                    → "lobby"    (MenuScene backdrop + CharacterPreview, music "lobby")
 *   countdown/playing/suddenDeath/roundEnd → "game" (GameController.enter; spectators too)
 *   matchEnd                       → "matchEnd" (GameController keeps rendering; podium overlay)
 *   disconnected                   → "home" + toast/error (Room full, No room with that code,
 *                                     Lost connection to the server…)
 * UI events → actions: createRoom/joinRoom (save nickname + lastCharacter in settings; character
 * = settings.lastCharacter), selectCharacter (net.sendCharacter + settings), setReady,
 * updateSettings, startMatch, rematch, leaveRoom (net.leave → home; history.replaceState to drop
 * ?room), backToPortal (net.leave then location.href = "/"), settingsChange (settings.set),
 * resume (input.requestPointerLock in the same gesture), emote (net.sendEmote), uiSound (audio).
 * Input events: menu → ui.openSettings + input.setEnabled(false); scoreboard → ui.setScoreboard;
 * emote (Q) → cycle honk → wave → dance and net.sendEmote; pointerLock false in game → click-to-play overlay.
 * The URL is kept in sync: after joining, history.replaceState to `?room=CODE` so a reload rejoins.
 */
export class App {
  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement) {
    void gameRoot;
    void uiRoot;
  }

  async start(): Promise<void> {
    // TODO(client-app)
  }
}
