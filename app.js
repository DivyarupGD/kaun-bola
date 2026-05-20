import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  runTransaction,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { questionBank } from "./question-bank.js?v=kahoot-19";

const DRAFT_KEY = "kaun-bola-host-draft-v9";
const DEVICE_KEY = "kaun-bola-device-id";
const PLAYER_KEY = "kaun-bola-player";
const HOST_ROOM_KEY = "kaun-bola-host-room";

const DEFAULT_ROUND_COUNT = 10;
const MIN_ROUND_COUNT = 1;
const MAX_ROUND_COUNT = 20;
const MIN_PLAYERS = 2;

const appNode = document.querySelector("#app");
const firebaseConfig = window.KAUN_BOLA_FIREBASE_CONFIG || {};
const hasFirebaseConfig =
  firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("PASTE_");

let firebaseApp = null;
let auth = null;
let db = null;
let user = null;
let unsubRoom = null;
let room = null;
let roomMissing = false;
let busy = false;
let notice = "";
let noticeScope = "global";

const view = {
  mode: "home",
  roomId: "",
  joinCode: "",
  joinName: "",
  playerId: "",
  deviceId: getDeviceId()
};

const draft = loadDraft();
const params = new URLSearchParams(window.location.search);
const roomFromUrl = normalizeRoomId(params.get("room") || "");
if (roomFromUrl) {
  view.mode = "join";
  view.joinCode = roomFromUrl;
}

function normalizeRoundCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_ROUND_COUNT;
  return Math.min(MAX_ROUND_COUNT, Math.max(MIN_ROUND_COUNT, Math.round(count)));
}

function defaultDeck(count = DEFAULT_ROUND_COUNT, excludedQuestions = []) {
  const roundCount = normalizeRoundCount(count);
  const excluded = new Set(excludedQuestions.map((question) => question.trim().toLowerCase()));
  return shuffle(questionBank)
    .filter((question) => !excluded.has(question.trim().toLowerCase()))
    .slice(0, roundCount);
}

function buildQuestionDeck(customQuestions, count) {
  const roundCount = normalizeRoundCount(count);

  const selectedCustomQuestions = customQuestions.slice(0, roundCount);
  const remainingCount = roundCount - selectedCustomQuestions.length;
  if (!remainingCount) return selectedCustomQuestions;

  return [
    ...selectedCustomQuestions,
    ...defaultDeck(remainingCount, selectedCustomQuestions)
  ];
}

function loadDraft() {
  const fallback = {
    hostName: "The Host",
    sessionCode: generateRoomId(),
    roundCount: DEFAULT_ROUND_COUNT,
    questions: []
  };

  try {
    const saved = { ...fallback, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") };
    saved.roundCount = normalizeRoundCount(saved.roundCount);
    saved.questions = Array.isArray(saved.questions)
      ? saved.questions.slice(0, saved.roundCount)
      : [];
    return saved;
  } catch {
    return fallback;
  }
}

function renderRoundCountOptions(selectedCount) {
  return Array.from({ length: MAX_ROUND_COUNT - MIN_ROUND_COUNT + 1 }, (_, index) => {
    const count = MIN_ROUND_COUNT + index;
    return `
    <option value="${count}" ${count === selectedCount ? "selected" : ""}>${count}</option>
  `;
  }).join("");
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function getDeviceId() {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;

  const value = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(DEVICE_KEY, value);
  return value;
}

function playerIdForDevice() {
  return `p-${view.deviceId.replace(/[^A-Za-z0-9-]/g, "")}`;
}

function generateRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function normalizeRoomId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);

  return Object.keys(value)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => value[key])
    .filter(Boolean);
}

function roomPlayers(currentRoom = room) {
  return Object.entries(currentRoom?.players || {}).map(([id, player]) => ({ id, ...player }));
}

function joinedPlayers(currentRoom = room) {
  return roomPlayers(currentRoom).filter((player) => player.joined);
}

function activePlayers(round, currentRoom = room) {
  const players = roomPlayers(currentRoom);
  const activeIds = toList(round?.activePlayerIds);
  return activeIds.map((id) => players.find((player) => player.id === id)).filter(Boolean);
}

function currentRound(currentRoom = room) {
  if (!currentRoom) return null;
  return currentRoom.rounds?.[currentRoom.roundIndex || 0] || null;
}

function playerById(playerId, currentRoom = room) {
  return roomPlayers(currentRoom).find((player) => player.id === playerId);
}

function getOwnPlayer(currentRoom = room) {
  const saved = JSON.parse(localStorage.getItem(PLAYER_KEY) || "{}");
  if (saved.roomId !== view.roomId) return null;

  const player = playerById(saved.playerId, currentRoom);
  if (!player || player.claimedBy !== view.deviceId) return null;
  return player;
}

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function setNotice(message, scope = "global") {
  notice = message;
  noticeScope = scope;
  render();
}

function clearNotice() {
  notice = "";
  noticeScope = "global";
}

function roomRef(roomId = view.roomId) {
  return ref(db, `rooms/${roomId}`);
}

function subscribeRoom(roomId) {
  if (!db || !roomId) return;
  if (unsubRoom) unsubRoom();

  view.roomId = roomId;
  unsubRoom = onValue(roomRef(roomId), (snapshot) => {
    room = snapshot.val();
    roomMissing = !snapshot.exists();

    if (room && view.mode === "join") {
      const ownPlayer = getOwnPlayer(room);
      if (ownPlayer) {
        view.playerId = ownPlayer.id;
        view.mode = "player-room";
      }
    }

    render();
  });
}

function buildShareUrl(roomId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}

async function initFirebase() {
  if (!hasFirebaseConfig) {
    render();
    return;
  }

  try {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getDatabase(firebaseApp);

    onAuthStateChanged(auth, (authUser) => {
      user = authUser;
      const lastHostRoom = localStorage.getItem(HOST_ROOM_KEY);
      if (!roomFromUrl && lastHostRoom && view.mode === "home") {
        view.mode = "host-room";
        subscribeRoom(lastHostRoom);
      }
      render();
    });

    await signInAnonymously(auth);
  } catch (error) {
    setNotice(`Firebase setup error: ${error.message}`);
  }
}

function renderHeader() {
  const roomLabel = view.roomId ? `Room ${view.roomId}` : "Party room";
  const statusLabel = view.mode === "home" ? "Ready" : !hasFirebaseConfig ? "Setup needed" : user ? "Online" : "Connecting";
  return `
    <header class="app-header">
      <div class="brand">
        <img class="brand-mark" src="./assets/mask.svg" alt="" />
        <div class="brand-text">
          <p class="brand-name">Kaun Bola?</p>
          <p class="brand-sub">${escapeHtml(roomLabel)}</p>
        </div>
      </div>
      <div class="host-pill">${statusLabel}</div>
    </header>
  `;
}

function renderNotice() {
  if (!notice) return "";
  return `<div class="notice">${escapeHtml(notice)}</div>`;
}

function renderScopedNotice(scope) {
  if (!notice || noticeScope !== scope) return "";
  return renderNotice();
}

function renderSetupWarning() {
  return `
    <section class="notice">
      Firebase is not connected yet. Edit firebase-config.js before Create Session / Join Session can work across phones.
    </section>
  `;
}

function renderHome() {
  return `
    <section class="screen">
      <div>
        <h1 class="screen-title">Kaun Bola?</h1>
        <p class="muted">Kahoot-style party rooms for anonymous funny answers.</p>
      </div>
      ${renderNotice()}
      <div class="home-actions">
        <button class="button primary big-action" data-action="show-host-setup">Create Session</button>
        <button class="button ghost big-action" data-action="show-join">Join Session</button>
      </div>
      <section class="info-card">
        <span class="chip teal">How it plays</span>
        <p class="info-text">The player whose answers are least often traced back to them wins.</p>
      </section>
    </section>
  `;
}

function renderHostSetup() {
  const roundCount = normalizeRoundCount(draft.roundCount);
  const customCount = draft.questions.length;
  const questionCountLabel = customCount ? `${customCount}/${roundCount}` : `auto ${roundCount}`;
  const fillCount = Math.max(0, roundCount - customCount);

  return `
    <section class="screen">
      <div>
        <h1 class="screen-title">Create Session.</h1>
        <p class="muted">Enter your host name, set the room PIN, and open the waiting room.</p>
      </div>
      ${renderNotice()}
      ${!hasFirebaseConfig ? renderSetupWarning() : ""}
      <div class="setup-grid">
        <section class="field-stack">
          <h2 class="section-title">Room</h2>
          <label class="field-label">
            Host name
            <input class="text-input" data-bind="hostName" maxlength="32" value="${escapeHtml(draft.hostName)}" />
          </label>
          <label class="field-label">
            Game PIN or session name
            <input class="text-input" data-bind="sessionCode" maxlength="16" autocapitalize="characters" value="${escapeHtml(draft.sessionCode)}" />
          </label>
          <label class="field-label">
            Number of questions
            <select class="text-input" data-bind="roundCount">
              ${renderRoundCountOptions(roundCount)}
            </select>
          </label>
        </section>

        <section class="wide">
          <h2 class="section-title">
            Questions
            <span class="section-count">${questionCountLabel}</span>
          </h2>
          <div class="list-stack">
            ${
              customCount
                ? draft.questions
                    .map(
                      (question, index) => `
                        <div class="question-row">
                          <div class="question-number">${index + 1}</div>
                          <textarea class="text-area" data-bind="questionText" data-question-index="${index}" rows="2" maxlength="150">${escapeHtml(question)}</textarea>
                          <button class="button icon-only ghost" data-action="remove-question" data-question-index="${index}" aria-label="Remove question ${index + 1}">
                            <span class="icon" aria-hidden="true">x</span>
                          </button>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="empty-panel">
                    <strong>Auto random deck</strong>
                    <span>${roundCount} random ${roundCount === 1 ? "question" : "questions"} will be picked when the session starts.</span>
                  </div>`
            }
            ${
              customCount && fillCount
                ? `<div class="empty-panel">
                    <strong>Auto fill</strong>
                    <span>${fillCount} random ${fillCount === 1 ? "question" : "questions"} will be added when the session starts.</span>
                  </div>`
                : ""
            }
          </div>
          <div class="actions">
            <button class="button ghost" data-action="add-question" ${customCount >= roundCount ? "disabled" : ""}>Add custom</button>
            <button class="button ghost" data-action="randomize-questions">Randomize now</button>
            <button class="button ghost" data-action="clear-questions" ${draft.questions.length ? "" : "disabled"}>Use auto</button>
          </div>
        </section>
      </div>

      <div class="actions">
        <button class="button primary" data-action="create-room" ${busy || !hasFirebaseConfig ? "disabled" : ""}>Create Session</button>
        <button class="button ghost" data-action="go-home">Back</button>
      </div>
    </section>
  `;
}

function renderJoinForm() {
  if (view.roomId && roomMissing) {
    return `
      <section class="screen">
        <div>
          <h1 class="screen-title">Room not found.</h1>
          <p class="muted">Check the code with the host and try again.</p>
        </div>
        ${renderJoinBox()}
      </section>
    `;
  }

  if (view.roomId && !room) {
    return `
      <section class="screen">
        <h1 class="screen-title">Finding room...</h1>
        <p class="muted">Looking for ${escapeHtml(view.roomId)}.</p>
      </section>
    `;
  }

  if (room) return renderPlayerJoin();

  return `
    <section class="screen">
      <div>
        <h1 class="screen-title">Join Session.</h1>
        <p class="muted">Enter the host's session code, then join with your own name.</p>
      </div>
      ${renderNotice()}
      ${!hasFirebaseConfig ? renderSetupWarning() : ""}
      ${renderJoinBox()}
    </section>
  `;
}

function renderJoinBox() {
  return `
    <section class="join-card">
      <label class="field-label">
        Game PIN or session name
        <input class="text-input" data-bind="joinCode" maxlength="16" autocapitalize="characters" placeholder="Example: PARTY7" value="${escapeHtml(view.joinCode || view.roomId)}" />
      </label>
      <div class="actions">
        <button class="button primary" data-action="find-room" ${!hasFirebaseConfig ? "disabled" : ""}>Join Session</button>
        <button class="button ghost" data-action="go-home">Back</button>
      </div>
    </section>
  `;
}

function renderPlayerJoin() {
  const players = roomPlayers();
  const ownPlayer = getOwnPlayer();
  const canJoin = room.phase === "lobby";

  if (ownPlayer) {
    view.playerId = ownPlayer.id;
    view.mode = "player-room";
    return renderPlayerRoom();
  }

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Room ${escapeHtml(view.roomId)}</span>
          <span class="chip gold">${escapeHtml(room.meta?.hostName || "Host")} hosting</span>
        </div>
        <h1 class="screen-title">Enter your name.</h1>
      </div>
      ${!canJoin ? `<div class="notice">This game has already started. Ask the host to restart or create a new room.</div>` : ""}
      ${renderNotice()}
      <section class="join-card">
        <label class="field-label">
          Your name
          <input class="text-input" data-bind="joinName" maxlength="28" autocomplete="name" placeholder="Example: Riya" value="${escapeHtml(view.joinName)}" />
        </label>
        <button class="button primary" data-action="join-player" ${canJoin ? "" : "disabled"}>Join Waiting Room</button>
      </section>
      ${renderPlayerStatusList(players)}
      <button class="button ghost" data-action="leave-room">Use another code</button>
    </section>
  `;
}

function renderHostRoom() {
  if (!room && !roomMissing) {
    return `<section class="screen"><h1 class="screen-title">Loading room...</h1></section>`;
  }

  if (roomMissing) {
    return `
      <section class="screen">
        <h1 class="screen-title">Host room missing.</h1>
        <p class="muted">Create a fresh session to continue.</p>
        <button class="button primary" data-action="show-host-setup">Create session</button>
      </section>
    `;
  }

  const phaseRenderers = {
    lobby: renderHostLobby,
    answer: renderHostAnswer,
    guess: renderHostGuess,
    reveal: renderHostReveal,
    end: renderEnd
  };
  return (phaseRenderers[room.phase] || renderHostLobby)();
}

function renderHostLobby() {
  const players = roomPlayers();
  const joined = joinedPlayers();
  const shareUrl = buildShareUrl(view.roomId);

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Host lobby</span>
          <span class="chip gold">${joined.length} joined</span>
        </div>
        <h1 class="screen-title">Players join with this PIN.</h1>
      </div>
      ${renderNotice()}
      <section class="session-panel">
        <span class="section-title">Game PIN</span>
        <div class="session-code">${escapeHtml(view.roomId)}</div>
        <div class="copy-row">
          <input class="text-input" readonly value="${escapeHtml(shareUrl)}" />
          <button class="button ghost" data-action="copy-link">Copy</button>
        </div>
      </section>

      ${renderPlayerStatusList(players)}

      <div class="actions">
        <button class="button primary" data-action="start-round" ${joined.length < MIN_PLAYERS || busy ? "disabled" : ""}>Start Game</button>
        <button class="button ghost" data-action="edit-new-room">New setup</button>
        <button class="button coral" data-action="delete-room">Delete room</button>
      </div>
      ${joined.length < MIN_PLAYERS ? `<p class="muted tiny">At least ${MIN_PLAYERS} players are needed before Start Game unlocks.</p>` : ""}
    </section>
  `;
}

function renderHostAnswer() {
  const round = currentRound();
  const active = activePlayers(round);
  const hostPlayer = playerById(playerIdForDevice());
  const hostIsActive = hostPlayer && toList(round.activePlayerIds).includes(hostPlayer.id);
  const hostAnswer = hostIsActive ? round.answers?.[hostPlayer.id]?.text || "" : "";
  const answerCount = active.filter((player) => round.answers?.[player.id]?.text).length;
  const complete = answerCount === active.length && active.length >= MIN_PLAYERS;

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Round ${(room.roundIndex || 0) + 1}</span>
          <span class="chip gold">${answerCount}/${active.length} answered</span>
        </div>
        <p class="question-display">${escapeHtml(round.question)}</p>
      </div>
      ${
        hostIsActive
          ? `<section class="join-card">
              <div class="player-inline">
                <div class="player-initials">${escapeHtml(initials(hostPlayer.name))}</div>
                <div>
                  <strong>${escapeHtml(hostPlayer.name)}</strong>
                  <span class="muted tiny">Host answer</span>
                </div>
              </div>
              ${renderScopedNotice(`host-answer-${room.roundIndex || 0}`)}
              <label class="field-label">
                Your answer
                <textarea id="hostAnswerText" class="text-area answer-input" maxlength="220" autocomplete="off" autocapitalize="sentences" placeholder="Make it funny. Make it deniable.">${escapeHtml(hostAnswer)}</textarea>
              </label>
              <button class="button primary" data-action="submit-host-answer">Submit host answer</button>
              ${hostAnswer ? `<div class="notice success">Submitted. You can edit until discussion starts.</div>` : ""}
            </section>`
          : ""
      }
      ${renderPlayerStatusList(
        active.map((player) => ({
          ...player,
          joined: Boolean(round.answers?.[player.id]?.text),
          statusLabel: round.answers?.[player.id]?.text ? "Submitted" : "Thinking"
        }))
      )}
      <div class="actions">
        <button class="button primary" data-action="open-discussion" ${complete ? "" : "disabled"}>Open discussion</button>
      </div>
    </section>
  `;
}

function renderHostGuess() {
  const round = currentRound();
  const active = activePlayers(round);
  const answerOrder = toList(round.order);
  const assignedCount = answerOrder.filter((playerId) => round.guesses?.[playerId]).length;
  const complete = assignedCount === answerOrder.length && answerOrder.length > 0;

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Discussion</span>
          <span class="chip gold">${assignedCount}/${answerOrder.length} locked</span>
        </div>
        <h1 class="screen-title">Who wrote what?</h1>
      </div>
      <div class="answer-stack">
        ${answerOrder
          .map((answerPlayerId, index) => {
            const answerText = round.answers?.[answerPlayerId]?.text || "";
            const guessedPlayerId = round.guesses?.[answerPlayerId];
            const usedElsewhere = new Set(
              Object.entries(round.guesses || {})
                .filter(([key, value]) => key !== answerPlayerId && value)
                .map(([, value]) => value)
            );

            return `
              <article class="answer-card">
                <span class="chip">Answer ${index + 1}</span>
                <p class="answer-text">${escapeHtml(answerText)}</p>
                <div class="guess-grid" role="group" aria-label="Guess writer for answer ${index + 1}">
                  ${active
                    .map((player) => {
                      const activeGuess = guessedPlayerId === player.id;
                      const unavailable = usedElsewhere.has(player.id) && !activeGuess;
                      return `
                        <button class="guess-button ${activeGuess ? "active" : ""} ${unavailable ? "used" : ""}" data-action="assign-guess" data-answer-player-id="${answerPlayerId}" data-player-id="${player.id}" ${unavailable ? "disabled" : ""}>
                          ${escapeHtml(player.name)}
                        </button>
                      `;
                    })
                    .join("")}
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
      <div class="actions">
        <button class="button primary" data-action="reveal-round" ${complete ? "" : "disabled"}>Reveal round</button>
      </div>
    </section>
  `;
}

function renderHostReveal() {
  const round = currentRound();
  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Reveal</span>
          <span class="chip gold">Round ${(room.roundIndex || 0) + 1}</span>
        </div>
        <h1 class="screen-title">The damage.</h1>
      </div>
      ${renderRevealCards(round)}
      ${renderScoreboard()}
      <div class="actions">
        <button class="button primary" data-action="next-round">
          ${(room.roundIndex || 0) + 1 >= toList(room.settings?.questions).length ? "Finish game" : "Next round"}
        </button>
        <button class="button coral" data-action="end-game">End Game</button>
      </div>
    </section>
  `;
}

function renderPlayerRoom() {
  if (!room && !roomMissing) {
    return `<section class="screen"><h1 class="screen-title">Joining...</h1></section>`;
  }

  if (roomMissing) {
    return `
      <section class="screen">
        <h1 class="screen-title">Room ended.</h1>
        <button class="button primary" data-action="go-home">Home</button>
      </section>
    `;
  }

  const player = getOwnPlayer();
  if (!player) {
    view.mode = "join";
    return renderPlayerJoin();
  }

  if (room.phase === "answer") return renderPlayerAnswer(player);
  if (room.phase === "reveal") return renderPlayerReveal(player);
  if (room.phase === "end") return renderEnd(false);

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">${escapeHtml(player.name)}</span>
          <span class="chip gold">Room ${escapeHtml(view.roomId)}</span>
        </div>
        <h1 class="screen-title">${room.phase === "guess" ? "Discussion time." : "Waiting for host."}</h1>
        <p class="muted">${room.phase === "guess" ? "Look at the host screen and accuse responsibly." : "You are in. The host will tap Start Game when everyone joins."}</p>
      </div>
      ${room.phase === "guess" ? renderAnonymousAnswers() : room.phase === "lobby" ? renderPlayerStatusList(joinedPlayers()) : renderScoreboard()}
      <button class="button ghost" data-action="leave-player">Leave name</button>
    </section>
  `;
}

function renderPlayerAnswer(player) {
  const round = currentRound();
  const existing = round.answers?.[player.id]?.text || "";
  const isActive = toList(round.activePlayerIds).includes(player.id);

  if (!isActive) {
    return `
      <section class="screen">
        <h1 class="screen-title">Watch this round.</h1>
        <p class="muted">You joined after this round started. You can play the next one.</p>
      </section>
    `;
  }

  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Round ${(room.roundIndex || 0) + 1}</span>
          <span class="chip gold">${escapeHtml(player.name)}</span>
        </div>
        <p class="question-display">${escapeHtml(round.question)}</p>
      </div>
      ${renderScopedNotice(`answer-${room.roundIndex || 0}`)}
      <label class="field-label">
        Your answer
        <textarea id="answerText" class="text-area answer-input" maxlength="220" autocomplete="off" autocapitalize="sentences" placeholder="Make it funny. Make it deniable.">${escapeHtml(existing)}</textarea>
      </label>
      <div class="actions">
        <button class="button primary" data-action="submit-answer">Submit answer</button>
      </div>
      ${existing ? `<div class="notice success">Submitted. You can edit until the host opens discussion.</div>` : ""}
    </section>
  `;
}

function renderAnonymousAnswers() {
  const round = currentRound();
  const answerOrder = toList(round?.order);
  if (!answerOrder.length) return "";

  return `
    <div class="answer-stack">
      ${answerOrder
        .map(
          (playerId, index) => `
            <article class="answer-card">
              <span class="chip">Answer ${index + 1}</span>
              <p class="answer-text">${escapeHtml(round.answers?.[playerId]?.text || "")}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPlayerReveal() {
  const round = currentRound();
  return `
    <section class="screen">
      <div>
        <div class="round-meta">
          <span class="chip teal">Reveal</span>
          <span class="chip gold">Room ${escapeHtml(view.roomId)}</span>
        </div>
        <h1 class="screen-title">Caught or hidden?</h1>
      </div>
      ${renderRevealCards(round)}
      ${renderScoreboard()}
    </section>
  `;
}

function renderRevealCards(round) {
  return `
    <div class="reveal-stack">
      ${toList(round.order)
        .map((answerPlayerId, index) => {
          const guessedPlayer = playerById(round.guesses?.[answerPlayerId]);
          const correct = round.guesses?.[answerPlayerId] === answerPlayerId;

          return `
            <article class="result-card ${correct ? "correct" : "wrong"}">
              <div class="result-head">
                <span class="chip">Answer ${index + 1}</span>
                <span class="result-badge">${correct ? "Caught" : "+1 mystery"}</span>
              </div>
              <p class="answer-text">${escapeHtml(round.answers?.[answerPlayerId]?.text || "")}</p>
              <p class="result-detail">Guessed ${escapeHtml(guessedPlayer?.name || "nobody")} - ${correct ? "Correct" : "Wrong"}</p>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPlayerStatusList(players) {
  if (!players.length) {
    return `
      <section>
        <h2 class="section-title">Players</h2>
        <div class="empty-panel">
          <strong>Waiting for players</strong>
          <span>Share the Game PIN. Joined players will appear here.</span>
        </div>
      </section>
    `;
  }

  return `
    <section>
      <h2 class="section-title">Players</h2>
      <div class="score-list">
        ${players
          .map(
            (player) => `
              <div class="score-row">
                <div class="player-initials">${escapeHtml(initials(player.name))}</div>
                <p class="score-name">${escapeHtml(player.name)}</p>
                <div class="status-badge ${player.joined ? "ready" : ""}">${escapeHtml(player.statusLabel || (player.id === room?.meta?.hostPlayerId ? "Host" : player.joined ? "Joined" : "Waiting"))}</div>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderScoreboard() {
  const scores = room?.scores || {};
  const players = roomPlayers().sort((a, b) => {
    const scoreDelta = Number(scores[b.id] || 0) - Number(scores[a.id] || 0);
    return scoreDelta || a.name.localeCompare(b.name);
  });

  return `
    <section>
      <h2 class="section-title">Mystery points</h2>
      <div class="score-list">
        ${players
          .map(
            (player) => `
              <div class="score-row">
                <div class="player-initials">${escapeHtml(initials(player.name))}</div>
                <p class="score-name">${escapeHtml(player.name)}</p>
                <div class="score-points">${Number(scores[player.id] || 0)}</div>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderEnd(showHostControls = true) {
  const scores = room?.scores || {};
  const ranked = roomPlayers().sort((a, b) => {
    const scoreDelta = Number(scores[b.id] || 0) - Number(scores[a.id] || 0);
    return scoreDelta || a.name.localeCompare(b.name);
  });
  const topScore = Number(scores[ranked[0]?.id] || 0);
  const winners = ranked.filter((player) => Number(scores[player.id] || 0) === topScore);
  const winnerText = winners.map((player) => player.name).join(", ");

  return `
    <section class="screen">
      <div class="winner-panel">
        <img class="winner-mask" src="./assets/mask.svg" alt="" />
        <div>
          <div class="round-meta">
            <span class="chip teal">Final score</span>
            <span class="chip gold">${topScore} mystery points</span>
          </div>
          <h1 class="screen-title">${escapeHtml(winnerText || "Nobody")} wins.</h1>
        </div>
      </div>
      ${renderScoreboard()}
      ${
        showHostControls
          ? `<div class="actions">
              <button class="button primary" data-action="restart-room">Play again</button>
              <button class="button coral" data-action="delete-room">Delete room</button>
            </div>`
          : ""
      }
    </section>
  `;
}

function render() {
  let content = "";

  if (hasFirebaseConfig && !user) {
    content = `
      <section class="screen">
        <h1 class="screen-title">Connecting...</h1>
        <p class="muted">Signing in anonymously for the party room.</p>
      </section>
    `;
  } else if (view.mode === "host-setup") {
    content = renderHostSetup();
  } else if (view.mode === "host-room") {
    content = renderHostRoom();
  } else if (view.mode === "join") {
    content = renderJoinForm();
  } else if (view.mode === "player-room") {
    content = renderPlayerRoom();
  } else {
    content = renderHome();
  }

  appNode.innerHTML = `${renderHeader()}<main>${content}</main>`;
}

function validateHostSetup() {
  const roomId = normalizeRoomId(draft.sessionCode);
  const roundCount = normalizeRoundCount(draft.roundCount);
  const customQuestions = draft.questions.map((question) => question.trim()).filter(Boolean);
  const questions = buildQuestionDeck(customQuestions, roundCount);

  if (!roomId) return { error: "Give the session a code or name." };
  if (!draft.hostName.trim()) return { error: "Give the host a name." };

  return {
    roomId,
    questions,
    roundCount,
    autoQuestions: customQuestions.length < roundCount
  };
}

async function createRoom() {
  const setup = validateHostSetup();
  if (setup.error) {
    setNotice(setup.error);
    return;
  }

  busy = true;
  render();

  const existing = await get(ref(db, `rooms/${setup.roomId}`));
  if (existing.exists() && !window.confirm(`Room ${setup.roomId} already exists. Replace it?`)) {
    busy = false;
    render();
    return;
  }

  const hostPlayerId = playerIdForDevice();
  const hostName = draft.hostName.trim();

  await set(ref(db, `rooms/${setup.roomId}`), {
    meta: {
      roomId: setup.roomId,
      hostName,
      hostPlayerId,
      hostDeviceId: view.deviceId,
      createdAt: Date.now()
    },
    settings: {
      questions: setup.questions,
      roundCount: setup.roundCount,
      autoQuestions: setup.autoQuestions
    },
    players: {
      [hostPlayerId]: {
        name: hostName,
        claimedBy: view.deviceId,
        joined: true,
        joinedAt: Date.now()
      }
    },
    scores: {
      [hostPlayerId]: 0
    },
    phase: "lobby",
    roundIndex: 0,
    rounds: {}
  });

  busy = false;
  clearNotice();
  view.mode = "host-room";
  view.roomId = setup.roomId;
  view.playerId = hostPlayerId;
  localStorage.setItem(HOST_ROOM_KEY, setup.roomId);
  localStorage.setItem(PLAYER_KEY, JSON.stringify({ roomId: setup.roomId, playerId: hostPlayerId }));
  subscribeRoom(setup.roomId);
}

async function joinPlayer() {
  if (!room || room.phase !== "lobby") return;

  const name = view.joinName.trim();
  if (!name) {
    setNotice("Enter your name to join.");
    return;
  }

  const duplicate = roomPlayers().find(
    (player) => player.name.trim().toLowerCase() === name.toLowerCase() && player.claimedBy !== view.deviceId
  );
  if (duplicate) {
    setNotice("That name is already in the room. Add an initial or nickname.");
    return;
  }

  const playerId = playerIdForDevice();
  const targetRef = ref(db, `rooms/${view.roomId}/players/${playerId}`);
  const result = await runTransaction(targetRef, (player) => {
    if (player?.claimedBy && player.claimedBy !== view.deviceId) return;

    return {
      name,
      claimedBy: view.deviceId,
      joined: true,
      joinedAt: Date.now()
    };
  });

  if (!result.committed) {
    setNotice("Could not join with that name. Try again.");
    return;
  }

  view.playerId = playerId;
  view.mode = "player-room";
  localStorage.setItem(PLAYER_KEY, JSON.stringify({ roomId: view.roomId, playerId }));
  await set(ref(db, `rooms/${view.roomId}/scores/${playerId}`), Number(room.scores?.[playerId] || 0));
  clearNotice();
  render();
}

async function leavePlayer() {
  const ownPlayer = getOwnPlayer();
  if (!ownPlayer || room.phase !== "lobby") {
    localStorage.removeItem(PLAYER_KEY);
    view.mode = "join";
    render();
    return;
  }

  await update(ref(db, `rooms/${view.roomId}/players/${ownPlayer.id}`), {
    claimedBy: "",
    joined: false,
    joinedAt: 0
  });
  localStorage.removeItem(PLAYER_KEY);
  view.playerId = "";
  view.mode = "join";
}

async function startRound(roundIndex = room.roundIndex || 0) {
  const activeIds = joinedPlayers().map((player) => player.id);
  const questions = toList(room.settings?.questions);

  if (activeIds.length < MIN_PLAYERS) {
    setNotice(`Wait for at least ${MIN_PLAYERS} players to join.`);
    return;
  }

  clearNotice();
  if (!questions.length || !questions[roundIndex]) {
    await update(roomRef(), {
      phase: "end",
      roundIndex: 0,
      rounds: {}
    });
    return;
  }

  const round = {
    question: questions[roundIndex],
    activePlayerIds: activeIds,
    answers: {},
    order: shuffle(activeIds),
    guesses: {},
    scored: false
  };

  await update(roomRef(), {
    phase: "answer",
    roundIndex,
    [`rounds/${roundIndex}`]: round
  });
}

async function submitAnswerForPlayer(player, selector, scope) {
  const round = currentRound();
  const text = document.querySelector(selector)?.value.trim() || "";

  if (!player || !round) {
    setNotice("Could not find your player session. Rejoin the room and try again.", scope);
    return;
  }
  if (!text) {
    setNotice("Blank answers are too easy to guess.", scope);
    return;
  }
  clearNotice();
  try {
    await set(ref(db, `rooms/${view.roomId}/rounds/${room.roundIndex}/answers/${player.id}`), {
      text,
      submittedAt: Date.now()
    });
    setNotice("Answer submitted. You can edit it until discussion starts.", scope);
  } catch (error) {
    setNotice(`Could not submit answer: ${error.message}`, scope);
  }
}

async function submitAnswer() {
  await submitAnswerForPlayer(getOwnPlayer(), "#answerText", `answer-${room?.roundIndex || 0}`);
}

async function submitHostAnswer() {
  await submitAnswerForPlayer(playerById(playerIdForDevice()), "#hostAnswerText", `host-answer-${room?.roundIndex || 0}`);
}

async function openDiscussion() {
  const round = currentRound();
  if (!round) return;

  const activeIds = toList(round.activePlayerIds);
  const allAnswered = activeIds.every((playerId) => round.answers?.[playerId]?.text);
  if (!allAnswered) {
    setNotice("Wait until every active player submits.");
    return;
  }

  clearNotice();
  await update(roomRef(), { phase: "guess" });
}

async function assignGuess(answerPlayerId, guessedPlayerId) {
  const round = currentRound();
  if (!round) return;

  const existing = round.guesses?.[answerPlayerId];
  const value = existing === guessedPlayerId ? null : guessedPlayerId;
  await set(ref(db, `rooms/${view.roomId}/rounds/${room.roundIndex}/guesses/${answerPlayerId}`), value);
}

async function revealRound() {
  const round = currentRound();
  if (!round) return;

  clearNotice();
  if (!round.scored) {
    const scores = { ...(room.scores || {}) };
    toList(round.activePlayerIds).forEach((playerId) => {
      scores[playerId] = Number(scores[playerId] || 0);
      if (round.guesses?.[playerId] !== playerId) {
        scores[playerId] += 1;
      }
    });

    await update(roomRef(), {
      scores,
      phase: "reveal",
      [`rounds/${room.roundIndex}/scored`]: true
    });
    return;
  }

  await update(roomRef(), { phase: "reveal" });
}

async function nextRound() {
  const nextIndex = (room.roundIndex || 0) + 1;
  const questions = toList(room.settings?.questions);

  clearNotice();
  if (nextIndex >= questions.length) {
    await update(roomRef(), { phase: "end" });
    return;
  }

  await startRound(nextIndex);
}

async function endGame() {
  if (!window.confirm("End the game and show the winner screen?")) return;
  clearNotice();
  await update(roomRef(), { phase: "end" });
}

async function restartRoom() {
  const players = roomPlayers();
  const scores = Object.fromEntries(players.map((player) => [player.id, 0]));
  const resetPlayers = Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        name: player.name,
        joined: player.claimedBy ? true : false,
        claimedBy: player.claimedBy || "",
        joinedAt: player.joinedAt || 0
      }
    ])
  );

  await update(roomRef(), {
    phase: "lobby",
    roundIndex: 0,
    rounds: {},
    scores,
    players: resetPlayers
  });
}

async function deleteRoom() {
  if (!window.confirm("Delete this room for everyone?")) return;
  await remove(roomRef());
  localStorage.removeItem(HOST_ROOM_KEY);
  localStorage.removeItem(PLAYER_KEY);
  room = null;
  roomMissing = false;
  view.roomId = "";
  view.mode = "home";
  render();
}

async function copyRoomLink() {
  const link = buildShareUrl(view.roomId);
  try {
    await navigator.clipboard.writeText(link);
    setNotice("Join link copied.");
  } catch {
    setNotice(link);
  }
}

function handleBoundInput(event) {
  const target = event.target;
  const bind = target.dataset.bind;
  if (!bind) return;
  if (event.type === "change" && target.tagName !== "SELECT") return;

  if (bind === "hostName") draft.hostName = target.value;
  if (bind === "sessionCode") draft.sessionCode = normalizeRoomId(target.value);
  if (bind === "roundCount") {
    draft.roundCount = normalizeRoundCount(target.value);
    draft.questions = draft.questions.slice(0, draft.roundCount);
    saveDraft();
    render();
    return;
  }
  if (bind === "questionText") {
    draft.questions[Number(target.dataset.questionIndex)] = target.value;
  }
  if (bind === "joinCode") {
    view.joinCode = normalizeRoomId(target.value);
  }
  if (bind === "joinName") {
    view.joinName = target.value;
  }

  saveDraft();
}

appNode.addEventListener("input", handleBoundInput);
appNode.addEventListener("change", handleBoundInput);

appNode.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget || actionTarget.disabled) return;

  const action = actionTarget.dataset.action;

  if (action === "go-home") {
    if (unsubRoom) unsubRoom();
    room = null;
    roomMissing = false;
    view.mode = "home";
    view.roomId = "";
    render();
  }

  if (action === "show-host-setup") {
    view.mode = "host-setup";
    render();
  }

  if (action === "show-join") {
    view.mode = "join";
    view.roomId = "";
    room = null;
    roomMissing = false;
    render();
  }

  if (action === "add-question") {
    draft.questions.push("");
    saveDraft();
    render();
  }

  if (action === "remove-question") {
    draft.questions.splice(Number(actionTarget.dataset.questionIndex), 1);
    saveDraft();
    render();
  }

  if (action === "randomize-questions") {
    draft.questions = defaultDeck(draft.roundCount);
    saveDraft();
    render();
  }

  if (action === "clear-questions") {
    draft.questions = [];
    saveDraft();
    render();
  }

  if (action === "create-room") await createRoom();

  if (action === "find-room") {
    const roomId = normalizeRoomId(view.joinCode || view.roomId);
    if (!roomId) {
      setNotice("Enter a session code.");
      return;
    }
    clearNotice();
    view.roomId = roomId;
    subscribeRoom(roomId);
  }

  if (action === "join-player") await joinPlayer();
  if (action === "leave-room") {
    if (unsubRoom) unsubRoom();
    localStorage.removeItem(PLAYER_KEY);
    view.mode = "join";
    view.roomId = "";
    room = null;
    roomMissing = false;
    render();
  }
  if (action === "leave-player") await leavePlayer();
  if (action === "copy-link") await copyRoomLink();
  if (action === "start-round") await startRound(0);
  if (action === "submit-answer") await submitAnswer();
  if (action === "submit-host-answer") await submitHostAnswer();
  if (action === "open-discussion") await openDiscussion();
  if (action === "assign-guess") {
    await assignGuess(actionTarget.dataset.answerPlayerId, actionTarget.dataset.playerId);
  }
  if (action === "reveal-round") await revealRound();
  if (action === "next-round") await nextRound();
  if (action === "end-game") await endGame();
  if (action === "restart-room") await restartRoom();
  if (action === "delete-room") await deleteRoom();
  if (action === "edit-new-room") {
    if (window.confirm("Create a new room setup? Current room will stay online until deleted.")) {
      view.mode = "host-setup";
      render();
    }
  }
});

render();
initFirebase();
