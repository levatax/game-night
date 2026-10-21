// Game Night portal: lists every game the hub knows about (from /api/games)
// and lets players jump into a room by its 4-letter code.

const CODE_RE = /^[A-HJ-NP-Z]{4}$/; // no I or O, same alphabet as the server
const REFRESH_MS = 15_000;
// No mouse or trackpad at all (phones, most tablets): games marked desktopOnly get a hint.
const finePointer = matchMedia("(any-pointer: fine)");

const grid = document.getElementById("game-grid");
const gamesMeta = document.getElementById("games-meta");
const featured = document.getElementById("featured");
const joinError = document.getElementById("join-error");
const details = document.getElementById("details");
const detailsContent = document.getElementById("details-content");
const footerMeta = document.getElementById("footer-meta");

let games = [];

const ICONS = {
  players:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2c2.9-.4 5 1.6 5.5 4.8"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/></svg>',
  input:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 2.5v6"/></svg>',
  keyboard:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="3"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10"/></svg>',
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const playersLabel = ({ min, max }) => (min === max ? `${min} players` : `${min}–${max} players`);

function liveLabel(live) {
  if (!live || live.players === 0) return { on: false, text: "No one playing right now. Start a room!" };
  const people = `${live.players} playing now`;
  const rooms = live.rooms === 1 ? "1 room" : `${live.rooms} rooms`;
  return { on: true, text: `${people} · ${rooms}` };
}

// --------------------------------------------------------------------- render
/**
 * "BETA" pill next to the title of games that are playable but still being tuned. The leading space keeps the
 * heading text (and the details dialog's accessible name) "Raft Rush BETA", not "Raft RushBETA".
 */
const betaTag = (game) =>
  game.status === "beta" ? ' <span class="beta" title="Playable, still being tested and tuned">BETA</span>' : "";

/** Games marked desktopOnly can't be played on this device (no mouse or trackpad). */
const needsKeyboardHere = (game) => game.desktopOnly && !finePointer.matches;

/** Keyboard + mouse reminder, only on devices without a fine pointer. */
function desktopHint(game, text) {
  if (!needsKeyboardHere(game)) return "";
  return `<p class="desktop-hint">${ICONS.keyboard}<span>${esc(text)}</span></p>`;
}

function metaList(game) {
  return `<ul class="meta">
    <li>${ICONS.players}${esc(playersLabel(game.players))}</li>
    ${game.duration ? `<li>${ICONS.time}${esc(game.duration)}</li>` : ""}
    ${game.input ? `<li>${ICONS.input}${esc(game.input)}</li>` : ""}
  </ul>`;
}

function playButton(game, extraClass = "") {
  if (game.playable) {
    return `<a class="btn btn--accent ${extraClass}" href="${esc(game.url)}">Play ${esc(game.title)}</a>`;
  }
  const why = game.status === "soon" ? "Coming soon" : game.serverDown ? "Unavailable right now" : "Not built yet";
  return `<span class="btn btn--accent ${extraClass}" aria-disabled="true">${why}</span>`;
}

function cardHtml(game) {
  const live = liveLabel(game.live);
  return `<article class="card" style="--accent:${esc(game.accent || "#FF5A5F")}" data-id="${esc(game.id)}">
    <button class="card__cover" type="button" data-details="${esc(game.id)}" aria-label="About ${esc(game.title)}">
      ${game.cover ? `<img src="${esc(game.cover)}" alt="" loading="lazy" />` : ""}
    </button>
    ${game.badge ? `<span class="card__badge">${esc(game.badge)}</span>` : ""}
    <div class="card__body">
      <h3 class="card__title">${esc(game.title)}${betaTag(game)}</h3>
      <p class="card__tagline">${esc(game.tagline)}</p>
      ${metaList(game)}
      ${desktopHint(game, "Needs a keyboard and mouse: play this one on a computer.")}
      <p class="live ${live.on ? "live--on" : ""}" data-live><span class="live__dot"></span><span>${esc(live.text)}</span></p>
      <div class="card__actions">
        ${playButton(game)}
        <button class="btn btn--ghost" type="button" data-details="${esc(game.id)}">How to play</button>
      </div>
      ${!game.playable && game.status !== "soon" && !game.serverDown ? '<p class="card__note">Run <code>npm run build</code> to build this game.</p>' : ""}
    </div>
  </article>`;
}

const soonCard = `<div class="card card--soon">
  <div class="soon__icons" aria-hidden="true"><span>?</span><span>?</span><span>?</span></div>
  <h3>More games on the way</h3>
  <p>New party games will show up here as they're added. Same deal: pick a name, share a code, play.</p>
</div>`;

function renderFeatured() {
  // On a touch-only device, feature a game it can actually play rather than a keyboard-only one.
  const game = games.find((g) => g.playable && !needsKeyboardHere(g)) ?? games.find((g) => g.playable) ?? games[0];
  if (!game) return;
  const keyboard = needsKeyboardHere(game) ? " · Needs a keyboard and mouse" : "";
  featured.innerHTML = `<a class="featured" href="${game.playable ? esc(game.url) : "#games"}" style="--accent:${esc(game.accent)}">
    <span class="sticker">${game.playable ? "PLAY NOW" : "FEATURED"}</span>
    ${game.cover ? `<img src="${esc(game.cover)}" alt="${esc(game.title)} cover art" />` : ""}
    <span class="featured__body">
      <span>
        <span class="featured__title">${esc(game.title)}</span><br />
        <span class="featured__tag">${esc(playersLabel(game.players))} · ${esc(game.duration)}${keyboard}</span>
      </span>
      <span class="btn btn--small btn--primary" aria-hidden="true">Play</span>
    </span>
  </a>`;
}

function renderGrid() {
  if (!games.length) {
    grid.innerHTML = `<p class="empty">No games yet. Add a folder with a <code>game.json</code> under <code>games/</code>.</p>${soonCard}`;
    gamesMeta.textContent = "0 games";
    return;
  }
  grid.innerHTML = games.map(cardHtml).join("") + soonCard;
  const playable = games.filter((g) => g.playable).length;
  gamesMeta.textContent = `${games.length} game${games.length === 1 ? "" : "s"} · ${playable} ready to play`;
}

function renderFooter() {
  const players = games.reduce((sum, g) => sum + (g.live?.players ?? 0), 0);
  footerMeta.textContent = players ? `${players} player${players === 1 ? "" : "s"} online` : "";
}

/** Update live counters in place so a refresh doesn't reset focus or scroll. */
function refreshLive() {
  for (const game of games) {
    const el = grid.querySelector(`[data-id="${CSS.escape(game.id)}"] [data-live]`);
    if (!el) continue;
    const live = liveLabel(game.live);
    el.classList.toggle("live--on", live.on);
    el.lastElementChild.textContent = live.text;
  }
  renderFooter();
}

function openDetails(id) {
  const game = games.find((g) => g.id === id);
  if (!game) return;
  const steps = (game.howToPlay ?? []).map((s) => `<li>${esc(s)}</li>`).join("");
  // "W A S D" becomes four keys; "Left click" stays one.
  const keycaps = (keys) => {
    const parts = keys.split(/\s+/);
    const list = parts.every((p) => p.length === 1) ? parts : [keys];
    return list.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ");
  };
  const controls = (game.controls ?? [])
    .map((c) => `<tr><td>${keycaps(c.keys)}</td><td>${esc(c.action)}</td></tr>`)
    .join("");
  detailsContent.innerHTML = `
    ${game.cover ? `<img class="details__cover" src="${esc(game.cover)}" alt="" />` : ""}
    <div class="details__body" style="--accent:${esc(game.accent)}">
      <h2 id="details-title">${esc(game.title)}${betaTag(game)}</h2>
      <p>${esc(game.description)}</p>
      ${metaList(game)}
      ${desktopHint(game, "This game has no touch controls. Open it on a computer with a keyboard and mouse to play.")}
      <div class="details__cols">
        ${steps ? `<section><h3>How to play</h3><ol>${steps}</ol></section>` : ""}
        ${controls ? `<section><h3>Controls</h3><table class="controls"><tbody>${controls}</tbody></table></section>` : ""}
      </div>
      <div class="details__actions">${playButton(game, "btn--big")}</div>
    </div>`;
  details.showModal();
}

// ------------------------------------------------------------------- loading
async function fetchGames() {
  const res = await fetch("/api/games", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).games;
}

async function load() {
  try {
    games = await fetchGames();
    renderGrid();
    renderFeatured();
    renderFooter();
  } catch (err) {
    console.error(err);
    gamesMeta.textContent = "";
    grid.innerHTML = `<p class="empty">Couldn't reach the game server. Is it running? Start it with <code>npm start</code>, then reload.</p>`;
  }
}

setInterval(async () => {
  if (document.hidden || !games.length) return;
  try {
    const fresh = await fetchGames();
    const byId = new Map(fresh.map((g) => [g.id, g]));
    if (fresh.length !== games.length || games.some((g) => !byId.has(g.id) || byId.get(g.id).playable !== g.playable)) {
      games = fresh;
      renderGrid();
      renderFeatured();
      renderFooter();
    } else {
      for (const g of games) g.live = byId.get(g.id).live;
      refreshLive();
    }
  } catch {
    /* keep showing the last good list */
  }
}, REFRESH_MS);

// ---------------------------------------------------------------------- join
function showJoinError(message) {
  joinError.textContent = message;
  joinError.hidden = !message;
}

for (const form of document.querySelectorAll("[data-join]")) {
  const input = form.querySelector("input");
  input.addEventListener("input", () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    if (clean !== input.value) input.value = clean;
    showJoinError("");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      showJoinError("Room codes are 4 letters, like ABCD.");
      input.focus();
      return;
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${code}`);
      if (res.status === 404) {
        showJoinError(`No room with code ${code}. Check the code, or ask your host for a fresh link.`);
        joinError.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { url } = await res.json();
      location.href = url;
    } catch {
      showJoinError("Couldn't reach the game server. Try again in a moment.");
    } finally {
      button.disabled = false;
    }
  });
}

// ------------------------------------------------------------------- events
grid.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-details]");
  if (trigger) openDetails(trigger.dataset.details);
});
details.addEventListener("click", (event) => {
  if (event.target === details) details.close(); // click on the backdrop
});
// A mouse plugged into (or pulled out of) a tablet changes which cards need the keyboard hint and which game
// the hero features.
finePointer.addEventListener("change", () => {
  if (!games.length) return;
  renderGrid();
  renderFeatured();
});

const missing = new URLSearchParams(location.search).get("missing");
if (missing) {
  showJoinError(`Room ${missing.toUpperCase()} has ended or doesn't exist. Ask your host for a new code.`);
  history.replaceState(null, "", location.pathname);
}

load();
