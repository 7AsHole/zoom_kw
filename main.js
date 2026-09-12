// initial the firebase and firestore database
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import "./zoom_kw.css";

// firebase config from environment variables 
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// connect to the firebaseconfig and get the database from firestore
const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

// Hard cap on participants in a single call (drives the 1x1 -> 3x3 grid).
const MAX_PEERS = 9;
let flipErrorCount = 0;

// A variable for get your ip, port and network path
const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

// A unique Variable for the user and coonect between each other inside a room
const myPeerId = crypto.randomUUID();

// A variable for connect to html id
const webcamButton = document.getElementById("webcamButton");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const hangupButton = document.getElementById("hangupButton");
const micButton = document.getElementById("micButton");
const sharescreenButton = document.getElementById("sharescreenButton");
const copyLink = document.getElementById("copyLink");
const liveDot = document.getElementById("liveDot");
const activeUser = document.getElementById("activeUser");
const introSplash = document.getElementById("introSplash");
const callGrid = document.getElementById("callGrid");
const flipcamButton = document.getElementById("flipcamButton");
const toastContainer = document.getElementById("toastContainer");
const helpButton = document.getElementById("helpButton");
const helpModal = document.getElementById("helpModal");

// Dict for tarcking the user count and for labeling
const peerNumbers = new Map();
let nextPeerNumber = 2; // "User 1" is always local

function getPeerNumber(peerId) {
  if (peerId === myPeerId) return 1;
  if (!peerNumbers.has(peerId)) {
    peerNumbers.set(peerId, nextPeerNumber++);
  }
  return peerNumbers.get(peerId);
}

// Automatically pin/focus a tile across the grid
function pinTile(tile) {
  if (!tile || participantTotal() < 2) return;

  callGrid
    .querySelectorAll(".participant-tile.focused")
    .forEach((t) => t.classList.remove("focused"));

  tile.classList.add("focused");
  callGrid.classList.add("has-focus");
}

// Focus the latest active screen share tile, or clear focus if none remain
function focusLatestScreenShare() {
  const screenTiles = Array.from(callGrid.querySelectorAll(".participant-tile"))
    .filter((t) => t.dataset.sharingScreen === "true" || t.dataset.isScreen === "true");

  if (screenTiles.length > 0) {
    // Priority goes to the latest screen share
    const latestTile = screenTiles[screenTiles.length - 1];
    pinTile(latestTile);
  } else {
    callGrid.classList.remove("has-focus");
    callGrid
      .querySelectorAll(".participant-tile.focused")
      .forEach((t) => t.classList.remove("focused"));
  }
}

function showToast(message, type = "error", timeoutMs = 4500) {
  if (!toastContainer) {
    // Absolute last resort if the container is somehow missing.
    console[type === "error" ? "error" : "log"](message);
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icon = document.createElement("i");
  icon.className =
    "toast-icon fa-solid " +
    (type === "error" ? "fa-circle-exclamation" : "fa-circle-info");

  const text = document.createElement("span");
  text.textContent = message;

  toast.append(icon, text);
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 300);
  }, timeoutMs);
}

function isMobileUA() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isDisplayCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

// Catch anything that slips through an un-caught promise anywhere in the
// app instead of failing silently.
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled error:", event.reason);
  const message =
    (event.reason && (event.reason.message || event.reason.name)) ||
    "Something unexpected went wrong.";
  showToast(message);
});

// Play the "ZOOM KW" intro once, then reveal the call page underneath.
if (introSplash) {
  document.body.classList.add("intro-active");
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  const introHoldMs = prefersReducedMotion ? 150 : 2100;

  setTimeout(() => {
    introSplash.classList.add("hide");
    document.body.classList.remove("intro-active");
    introSplash.addEventListener(
      "transitionend",
      () => introSplash.remove(),
      { once: true }
    );
  }, introHoldMs);
}

// --- Step-by-step help modal (the grey "?" beside "Call") ---------------
if (helpButton && helpModal) {
  const openHelp = () => {
    helpModal.hidden = false;
  };
  const closeHelp = () => {
    helpModal.hidden = true;
  };

  helpButton.addEventListener("click", openHelp);
  helpModal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeHelp)
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !helpModal.hidden) closeHelp();
  });
}

// Prefill the call ID from a shared link like ?call=abc123
const prefillCallId = new URLSearchParams(window.location.search).get("call");
if (prefillCallId) callInput.value = prefillCallId;

let localStream = null;
let screenStream = null;
let micEnabled = true;
let camEnabled = true;
let inCall = false;
let roomId = null;
let roomRef = null;
let peersColRef = null;
let unsubPeers = null;
let localTile = null;
let localScreenTile = null; // separate tile for your own screen, only exists when camera + screen are both on
let nextTileNumber = 1; // "User 1" is always the local tile
let currentFacingMode = 'user';

// peerId -> display number ("User N"), so a participant's camera tile and
// their screen tile always show the same number instead of the screen tile
// grabbing the next free one.
const peerDisplayNumber = new Map();

// Which tile (if any) the local viewer has manually pinned by clicking it.
// A manual pin always wins over auto-focus; see applyAutoFocus() below.
let pinnedTile = null;

// tile -> the timestamp its owner started sharing that tile's screen.
// Drives "auto-focus the most recently started share" when nothing is
// manually pinned.
const activeScreenShares = new Map();

// ownerPeerId -> volume factor (0..2). A participant's camera tile and
// screen tile share one entry, so adjusting either slider moves both -
// zoom/size stays independent per tile (see tileZoomIndex).
const participantVolume = new Map();

// remotePeerId -> { pc, stream, tileEl, unsubs: [], pendingCandidates: [] }
const peers = new Map();
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_TIMEOUT_MS = 15000;

let presenceHeartbeatTimer = null;
let presenceCleanupTimer = null;

callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;
copyLink.disabled = true;

/* =========================================================================
   1. Keep audio alive when the tab/app is minimized (Android/iOS)
   ---------------------------------------------------------------------
   Mobile OSes are aggressive about suspending backgrounded browser tabs.
   Two things help a real WebRTC audio track keep flowing instead of the
   whole page (and its sockets/timers) getting frozen:

   1. A Screen Wake Lock while the call is active and the page is visible,
      re-acquired whenever the app comes back to the foreground (wake locks
      are always released while hidden - they can't prevent backgrounding
      itself, but they stop the screen sleeping mid-call and help the page
      resume cleanly).
   2. A silent, always-playing <audio> element. Browsers (especially iOS
      Safari) treat a page with active "media playback" much more leniently
      when backgrounded than an otherwise idle tab - this is the same trick
      background radio/podcast web players use. It does NOT guarantee
      indefinite background operation and it can't keep the *camera* alive
      (iOS revokes camera access the instant a tab backgrounds - that's an
      OS-level privacy rule no website can bypass), but it meaningfully
      extends how long your mic audio and the underlying connection survive.

   The silent track is generated at runtime with Web Audio (no external
   asset needed), so there's nothing to fetch or that can 404. */

let wakeLock = null;
let keepAliveAudioEl = null;
let keepAliveCtx = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    // Not fatal - just means the screen may sleep during the call.
    console.warn("Wake lock unavailable:", err);
  }
}

function startBackgroundAudioKeepAlive() {
  try {
    if (keepAliveAudioEl) return; // already running
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    keepAliveCtx = new AudioContextClass();
    const oscillator = keepAliveCtx.createOscillator();
    const gain = keepAliveCtx.createGain();
    gain.gain.value = 0.00001; // effectively silent, but a real signal
    const destination = keepAliveCtx.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();

    keepAliveAudioEl = document.createElement("audio");
    keepAliveAudioEl.srcObject = destination.stream;
    keepAliveAudioEl.setAttribute("playsinline", "");
    keepAliveAudioEl.autoplay = true;
    keepAliveAudioEl.style.display = "none";
    document.body.appendChild(keepAliveAudioEl);
    keepAliveAudioEl.play().catch((err) => {
      console.warn("Background keep-alive audio couldn't start:", err);
    });

    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: "ZOOM KW — call in progress",
        });
        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.setActionHandler("play", () => {});
        navigator.mediaSession.setActionHandler("pause", () => {});
      } catch (err) {
        console.warn("mediaSession setup failed:", err);
      }
    }
  } catch (err) {
    console.warn("Could not start background audio keep-alive:", err);
  }
}

function stopBackgroundAudioKeepAlive() {
  if (keepAliveAudioEl) {
    keepAliveAudioEl.pause();
    keepAliveAudioEl.srcObject = null;
    keepAliveAudioEl.remove();
    keepAliveAudioEl = null;
  }
  if (keepAliveCtx) {
    keepAliveCtx.close().catch(() => {});
    keepAliveCtx = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "none";
  }
}

document.addEventListener("visibilitychange", async () => {
  if (!inCall) return;
  if (document.visibilityState === "visible") {
    await requestWakeLock();
    if (keepAliveCtx && keepAliveCtx.state === "suspended") {
      keepAliveCtx.resume().catch(() => {});
    }
  }
});

let screenAudioMixCtx = null;

function mixAudioStreams(micStream, screenAudioTrack) {
  if (screenAudioMixCtx) {
    screenAudioMixCtx.close().catch(() => {});
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  screenAudioMixCtx = new AudioContextClass();

  const destination = screenAudioMixCtx.createMediaStreamDestination();

  // 1. Connect Microphone Track
  if (micStream && micStream.getAudioTracks().length > 0) {
    const micSource = screenAudioMixCtx.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  // 2. Connect Screen Share Audio Track
  if (screenAudioTrack) {
    const tempScreenStream = new MediaStream([screenAudioTrack]);
    const screenSource = screenAudioMixCtx.createMediaStreamSource(tempScreenStream);
    screenSource.connect(destination);
  }

  // Return the newly combined audio track
  return destination.stream.getAudioTracks()[0];
}

/* =========================================================================
   2. Grid helpers
   ========================================================================= */

function participantTotal() {
  return callGrid.children.length;
}

function updateParticipantCount() {
  const total = participantTotal();
  callGrid.dataset.count = String(Math.min(total, MAX_PEERS));

  if (total < 2) {
    callGrid.classList.remove("has-focus");
    callGrid
      .querySelectorAll(".participant-tile.focused")
      .forEach((tile) => tile.classList.remove("focused"));
  }

  if (!inCall) {
    activeUser.textContent = "Belum dimulai · 0 peserta";
    liveDot.classList.remove("live");
  } else {
    activeUser.textContent = `Berlangsung · ${total} peserta`;
    liveDot.classList.add("live");
  }
}

function setTileMicState(tileEl, enabled) {
  if (!tileEl) return;
  const icon = tileEl.querySelector(".mic-icon");
  icon.classList.toggle("muted", !enabled);
  icon.classList.toggle("active", enabled);
}

// Tracks whether a tile IS a dedicated screen-share tile currently being
// shared. Feeds the auto-focus priority (latest active share wins) and the
// little "sharing" indicator icon in the tile's tag.
function setTileScreenShareState(tileEl, sharingScreen, sharingScreenAudio) {
  if (!tileEl) return;
  const wasSharing = tileEl.dataset.sharingScreen === "true";
  tileEl.dataset.sharingScreen = sharingScreen ? "true" : "false";
  tileEl.dataset.sharingScreenAudio = sharingScreenAudio ? "true" : "false";
  const icon = tileEl.querySelector(".share-icon");
  if (icon) icon.classList.toggle("sharing", sharingScreen);

  if (sharingScreen && !wasSharing) {
    activeScreenShares.set(tileEl, Date.now());
    applyAutoFocus();
  } else if (!sharingScreen && wasSharing) {
    activeScreenShares.delete(tileEl);
    applyAutoFocus();
  }
}

function setTileStreamVisible(tileEl, visible) {
  if (!tileEl) return;
  tileEl.classList.toggle("has-stream", visible);
}

function updateLocalVideoMirror() {
  const videoEl = localTile?.querySelector("video");
  if (!videoEl) return;
  // In two-tile mode localTile keeps showing the camera the whole time, so
  // don't key off "is a share active" - key off what's actually in this
  // tile's srcObject right now (swap mode moves screenStream into it).
  const showingCamera = videoEl.srcObject !== screenStream;
  videoEl.classList.toggle("front-camera", currentFacingMode === "user" && showingCamera);
}

// --- Dynamic "spotlight" grid scaling (requirement #2) -------------------
// Tapping a tile grows it to fill the main area while every other tile
// shrinks into a thumbnail strip. Only one tile can be focused at a time.
// Priority: a manual pin (clicking a tile) always wins; with nothing
// pinned, the grid auto-focuses whichever screen share started most
// recently, for every participant watching - not just the person sharing.
function setFocusedTile(tile) {
  callGrid
    .querySelectorAll(".participant-tile.focused")
    .forEach((t) => t.classList.remove("focused"));

  if (tile && participantTotal() >= 2) {
    tile.classList.add("focused");
    callGrid.classList.add("has-focus");
  } else {
    callGrid.classList.remove("has-focus");
  }
}

function latestScreenShareTile() {
  let best = null;
  let bestTime = -Infinity;
  for (const [tile, startedAt] of activeScreenShares) {
    if (!tile.isConnected) continue; // stale reference to a removed tile
    if (startedAt > bestTime) {
      best = tile;
      bestTime = startedAt;
    }
  }
  return best;
}

function applyAutoFocus() {
  if (pinnedTile) return; // manual pin has priority - leave it alone
  setFocusedTile(latestScreenShareTile());
}

function toggleFocusTile(tile) {
  if (participantTotal() < 2) return;

  if (pinnedTile === tile) {
    // Explicit unpin - fall back to auto-focusing the latest share, if any.
    pinnedTile = null;
    applyAutoFocus();
  } else {
    pinnedTile = tile;
    setFocusedTile(tile);
  }
}

// --- Per-tile digital zoom (requirement #3) -------------------------------
// This is a CSS scale of the local <video> preview element only, so it's
// safe to offer on every tile (yours and everyone else's) - it never
// changes what's actually sent over the wire, only how it's displayed for
// you. It applies equally whether that tile's video is the webcam or an
// active screen share (same <video> element either way).
const ZOOM_LEVELS = [1, 1.25, "contain"];

// tile -> index into ZOOM_LEVELS. Shared so the magnifying-glass button and
// the "Size" dropdown in the tile options menu always agree on state.
const tileZoomIndex = new WeakMap();

function applyZoomLevel(tile, video, index) {
  const level = ZOOM_LEVELS[index];

  if (level === "contain") {
    video.style.transform = "";
    video.style.objectFit = "contain";
  } else {
    video.style.objectFit = "cover";
    const mirrorTransform = video.classList.contains("front-camera")
      ? "scaleX(-1)"
      : "";
    video.style.transform =
      level === 1 ? mirrorTransform : `${mirrorTransform} scale(${level})`;
  }

  tileZoomIndex.set(tile, index);
  return level;
}

function zoomButtonLabel(level) {
  return level === 1.25
    ? "Zoomed 1.25x — tap to change"
    : level === "contain"
      ? "Fit video — tap to change"
      : "Zoom video";
}

function attachZoomControl(tile, video) {
  const zoomBtn = document.createElement("button");
  zoomBtn.type = "button";
  zoomBtn.className = "zoom-btn";
  zoomBtn.title = "Zoom video";
  zoomBtn.setAttribute("aria-label", "Zoom this camera or screen share");
  zoomBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';

  zoomBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextIndex = ((tileZoomIndex.get(tile) ?? 0) + 1) % ZOOM_LEVELS.length;
    const level = applyZoomLevel(tile, video, nextIndex);
    zoomBtn.classList.toggle("zoom-active", level === 1.25);
    zoomBtn.title = zoomButtonLabel(level);
    syncTileMenuSize(tile);
  });

  tile.appendChild(zoomBtn);
  return zoomBtn;
}

/* =========================================================================
   2b. Per-tile options menu: right-click (desktop) or the "..." button
   (mobile) opens a small popup with Size and Volume controls. Both are
   purely local/view-side - they never affect what other participants see
   or hear.
   ========================================================================= */

// tile -> { source, volumeGain }. Remote audio is routed through this graph
// instead of letting the <video> element play it directly, which is what
// makes a per-participant volume slider possible.
const tileAudioGains = new WeakMap();
let audioMixContext = null;

function getAudioMixContext() {
  if (!audioMixContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioMixContext = new AudioContextClass();
  }
  if (audioMixContext.state === "suspended") {
    audioMixContext.resume().catch(() => {});
  }
  return audioMixContext;
}

// Both of a participant's tiles (camera + screen, when they're split) report
// the same owner id via tile.dataset.peerId, so this always finds every tile
// that a volume change on either one needs to reach.
function getTilesForOwner(ownerPeerId) {
  if (ownerPeerId === myPeerId) {
    return [localTile, localScreenTile].filter(Boolean);
  }
  const peerEntry = peers.get(ownerPeerId);
  if (!peerEntry) return [];
  return [peerEntry.tileEl, peerEntry.screenTileEl].filter(Boolean);
}

function getParticipantVolume(ownerPeerId) {
  return participantVolume.get(ownerPeerId) ?? 1;
}

// Setting a participant's volume applies it to every tile they currently
// have on screen (camera and/or screen share) - that's the "one changes,
// the other changes too" behavior, while Size/zoom stays per-tile.
function setParticipantVolume(ownerPeerId, factor) {
  participantVolume.set(ownerPeerId, factor);
  getTilesForOwner(ownerPeerId).forEach((tile) => {
    const gains = tileAudioGains.get(tile);
    if (gains) gains.volumeGain.gain.value = factor;
  });
}

// Sets up the gain graph for one tile's incoming audio, seeded with
// whatever volume is already set for that participant (so a screen tile
// created mid-call inherits the level you already picked for their camera).
function ensureTileAudioGraph(tile, stream, ownerPeerId) {
  if (tileAudioGains.has(tile)) return tileAudioGains.get(tile);
  if (!stream.getAudioTracks().length) return null;

  try {
    const ctx = getAudioMixContext();
    const source = ctx.createMediaStreamSource(stream);
    const volumeGain = ctx.createGain();
    volumeGain.gain.value = getParticipantVolume(ownerPeerId);
    source.connect(volumeGain).connect(ctx.destination);

    const entry = { source, volumeGain };
    tileAudioGains.set(tile, entry);
    return entry;
  } catch (err) {
    console.warn("Could not set up per-tile volume control:", err);
    return null;
  }
}

function teardownTileAudioGraph(tile) {
  const gains = tileAudioGains.get(tile);
  if (!gains) return;
  try {
    gains.source.disconnect();
    gains.volumeGain.disconnect();
  } catch (err) {
    /* already disconnected - fine */
  }
  tileAudioGains.delete(tile);
}

function attachMenuButton(tile, video) {
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "tile-menu-btn";
  menuBtn.title = "Size & volume";
  menuBtn.setAttribute("aria-label", "Open size and volume options for this tile");
  menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';

  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openTileMenu(tile, video, menuBtn, null);
  });

  tile.appendChild(menuBtn);
  return menuBtn;
}

let tileMenuEl = null;
let tileMenuTargetTile = null;

function ensureTileMenu() {
  if (tileMenuEl) return tileMenuEl;

  tileMenuEl = document.createElement("div");
  tileMenuEl.className = "tile-menu";
  tileMenuEl.hidden = true;
  tileMenuEl.innerHTML = `
    <div class="tile-menu-row">
      <label for="tileMenuSize">Size</label>
      <select id="tileMenuSize" class="tile-menu-size">
        <option value="0">1x</option>
        <option value="1">1.25x</option>
        <option value="2">Fit (contain)</option>
      </select>
    </div>
    <div class="tile-menu-row tile-menu-volume-row">
      <label for="tileMenuVolume">Volume <span class="tile-menu-value">100%</span></label>
      <input id="tileMenuVolume" class="tile-menu-volume" type="range" min="0" max="200" step="5" value="100" />
    </div>
  `;
  document.body.appendChild(tileMenuEl);

  const sizeSelect = tileMenuEl.querySelector(".tile-menu-size");
  const volumeInput = tileMenuEl.querySelector(".tile-menu-volume");
  const volumeValue = tileMenuEl.querySelector(".tile-menu-volume-row .tile-menu-value");

  sizeSelect.addEventListener("change", () => {
    if (!tileMenuTargetTile) return;
    const video = tileMenuTargetTile.querySelector("video");
    const zoomBtn = tileMenuTargetTile.querySelector(".zoom-btn");
    const level = applyZoomLevel(tileMenuTargetTile, video, Number(sizeSelect.value));
    if (zoomBtn) {
      zoomBtn.classList.toggle("zoom-active", level === 1.25);
      zoomBtn.title = zoomButtonLabel(level);
    }
  });

  // Volume is per-participant (see setParticipantVolume), so moving this
  // slider from either the camera tile or the screen tile of the same
  // person updates both.
  volumeInput.addEventListener("input", () => {
    if (!tileMenuTargetTile) return;
    volumeValue.textContent = `${volumeInput.value}%`;
    setParticipantVolume(tileMenuTargetTile.dataset.peerId, Number(volumeInput.value) / 100);
  });

  document.addEventListener("click", (event) => {
    if (tileMenuEl.hidden) return;
    if (tileMenuEl.contains(event.target)) return;
    if (event.target.closest(".tile-menu-btn")) return;
    closeTileMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTileMenu();
  });

  window.addEventListener("resize", () => {
    if (tileMenuEl && !tileMenuEl.hidden) closeTileMenu();
  });
  window.addEventListener(
    "scroll",
    () => {
      if (tileMenuEl && !tileMenuEl.hidden) closeTileMenu();
    },
    true
  );

  return tileMenuEl;
}

function closeTileMenu() {
  if (tileMenuEl) tileMenuEl.hidden = true;
  tileMenuTargetTile = null;
}

function openTileMenu(tile, video, anchorBtn, clickPoint) {
  const menu = ensureTileMenu();
  tileMenuTargetTile = tile;

  const isLocal = tile.dataset.isLocal === "true";
  const ownerPeerId = tile.dataset.peerId;

  const volumeRow = menu.querySelector(".tile-menu-volume-row");
  volumeRow.hidden = isLocal;

  const sizeSelect = menu.querySelector(".tile-menu-size");
  sizeSelect.value = String(tileZoomIndex.get(tile) ?? 0);

  const volumeInput = menu.querySelector(".tile-menu-volume");
  const volumeValue = menu.querySelector(".tile-menu-volume-row .tile-menu-value");
  const volumePercent = Math.round(getParticipantVolume(ownerPeerId) * 100);
  volumeInput.value = String(volumePercent);
  volumeValue.textContent = `${volumePercent}%`;

  menu.hidden = false;

  let x;
  let y;
  if (anchorBtn) {
    const rect = anchorBtn.getBoundingClientRect();
    x = rect.left;
    y = rect.bottom + 6;
  } else if (clickPoint) {
    x = clickPoint.x;
    y = clickPoint.y;
  } else {
    const rect = tile.getBoundingClientRect();
    x = rect.left + 12;
    y = rect.top + 12;
  }

  requestAnimationFrame(() => {
    if (menu.hidden) return; // could have been closed already
    const menuRect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - menuRect.width - 8);
    const maxY = Math.max(8, window.innerHeight - menuRect.height - 8);
    menu.style.left = `${Math.min(Math.max(8, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(8, y), maxY)}px`;
  });
}

// Keeps the Size dropdown correct if the magnifying-glass button is used
// while the menu for that same tile happens to be open.
function syncTileMenuSize(tile) {
  if (!tileMenuEl || tileMenuEl.hidden || tileMenuTargetTile !== tile) return;
  tileMenuEl.querySelector(".tile-menu-size").value = String(tileZoomIndex.get(tile) ?? 0);
}

function createTile(peerId, { isLocal, isScreen = false } = {}) {
  let baseLabel;
  if (isLocal) {
    baseLabel = "You";
  } else {
    if (!peerDisplayNumber.has(peerId)) {
      peerDisplayNumber.set(peerId, nextTileNumber++);
    }
    baseLabel = `User ${peerDisplayNumber.get(peerId)}`;
  }
  const label = isScreen ? `${baseLabel} · Screen` : baseLabel;

  const tile = document.createElement("div");
  tile.className = "participant-tile" + (isScreen ? " screen-tile" : "");
  // Both of a participant's tiles (camera + screen) share this id - it's
  // what lets the volume slider on either one control both (see
  // getTilesForOwner). dataset.isLocal/.isScreen disambiguate the tile
  // itself where that matters (e.g. hiding Volume on your own tiles).
  tile.dataset.peerId = peerId;
  tile.dataset.isLocal = isLocal ? "true" : "false";
  tile.dataset.isScreen = isScreen ? "true" : "false";
  tile.dataset.sharingScreen = "false";
  tile.dataset.sharingScreenAudio = "false";

  tile.addEventListener("click", (event) => {
    if (event.target.closest(".zoom-btn") || event.target.closest(".tile-menu-btn")) return; // handled separately
    toggleFocusTile(tile);
  });

  // Right-click opens the same Size/Volume popup as the "..." button below,
  // for anyone with a mouse.
  tile.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openTileMenu(tile, tile.querySelector("video"), null, {
      x: event.clientX,
      y: event.clientY,
    });
  });

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const avatar = document.createElement("div");
  avatar.className = "avatar" + (isLocal ? " local" : "") + (isScreen ? " screen-avatar" : "");
  if (isScreen) {
    avatar.innerHTML = '<i class="fa-solid fa-display"></i>';
  } else {
    avatar.textContent = isLocal ? "U1" : `U${peerDisplayNumber.get(peerId)}`;
  }

  const tag = document.createElement("div");
  tag.className = "tile-tag";

  const micIcon = document.createElement("i");
  micIcon.className = "mic-icon fa-solid fa-microphone active";

  const shareIcon = document.createElement("i");
  shareIcon.className = "share-icon fa-solid fa-display";
  shareIcon.title = "Sharing screen";

  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;

  // A dedicated screen tile IS the share, so its mic icon (nobody's voice
  // comes through it) is pointless - only show the tag's name + share icon.
  if (isScreen) {
    tag.append(shareIcon, nameSpan);
  } else {
    tag.append(micIcon, shareIcon, nameSpan);
  }
  tile.append(video, avatar, tag);

  // Zoom (right) and the "..." options menu (left) are local view controls
  // only - offered on every tile, yours and everyone else's, since neither
  // one changes what's actually sent to anybody.
  attachZoomControl(tile, video);
  attachMenuButton(tile, video);

  callGrid.appendChild(tile);
  updateParticipantCount();

  return tile;
}

function removeTile(tileEl) {
  if (!tileEl) return;
  const wasPinned = pinnedTile === tileEl;
  const hadActiveShare = activeScreenShares.has(tileEl);
  if (wasPinned) pinnedTile = null;
  activeScreenShares.delete(tileEl);
  if (tileMenuTargetTile === tileEl) closeTileMenu();
  teardownTileAudioGraph(tileEl);
  if (tileEl.parentElement) tileEl.remove();
  updateParticipantCount();
  if ((wasPinned || hadActiveShare) && participantTotal() >= 2) {
    applyAutoFocus();
  }
}

function pairId(a, b) {
  return [a, b].sort().join("_");
}

/* =========================================================================
   3. Signaling / WebRTC (with error handling instead of silent failure)
   ========================================================================= */

// ICE candidates can arrive over Firestore before the remote SDP has been
// applied. Queue them per-peer and flush once setRemoteDescription resolves.
async function addIceCandidateSafe(peerEntry, candidateData) {
  const { pc } = peerEntry;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (err) {
      console.error("Failed to add ICE candidate:", err);
      showToast("Connection hiccup with a participant - retrying.");
    }
  } else {
    peerEntry.pendingCandidates.push(candidateData);
  }
}

async function flushPendingCandidates(peerEntry) {
  const queued = peerEntry.pendingCandidates.splice(0);
  for (const candidateData of queued) {
    try {
      await peerEntry.pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (err) {
      console.error("Failed to add queued ICE candidate:", err);
    }
  }
}

async function connectToPeer(remoteId) {
  if (peers.has(remoteId)) return;
  if (participantTotal() >= MAX_PEERS) return; // room is full

  const pc = new RTCPeerConnection(servers);
  // A fixed, arbitrary tie-break so exactly one side is "polite" for the
  // life of the connection - see the perfect-negotiation pattern below.
  const polite = myPeerId > remoteId;

  const peerEntry = {
    pc,
    polite,
    stream: new MediaStream(),
    primaryStreamId: null,
    screenStream: null,
    tileEl: null,
    screenTileEl: null,
    screenVideoSender: null,
    screenAudioSender: null,
    unsubs: [],
    pendingCandidates: [],
    lastSeenMs: Date.now(),
    makingOffer: false,
  };
  peers.set(remoteId, peerEntry);

  const pid = pairId(myPeerId, remoteId);
  const signalRef = doc(collection(roomRef, "signals"), pid);
  const candidatesCol = collection(signalRef, "candidates");

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // If we're already mid-screen-share-with-camera-on when someone new
  // joins, give them the screen track too in the same negotiation round.
  if (screenStream && localScreenTile) {
    attachScreenTrackToPeer(
      peerEntry,
      screenStream.getVideoTracks()[0],
      screenStream.getAudioTracks()[0] || null
    );
  }

  pc.ontrack = (event) => handleRemoteTrack(remoteId, peerEntry, event);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      addDoc(candidatesCol, { ...event.candidate.toJSON(), from: myPeerId }).catch((err) =>
        console.error("Failed to send ICE candidate:", err)
      );
    }
  };

  // Perfect negotiation: either side can add/remove tracks at any time
  // (this is what lets screen-share start/stop mid-call add a whole new
  // video+audio transceiver instead of only ever swapping the original
  // one). "impolite" peer's offer always wins a collision; "polite" peer
  // rolls back and accepts it instead.
  pc.onnegotiationneeded = async () => {
    try {
      peerEntry.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await setDoc(
        signalRef,
        {
          offer: { type: offer.type, sdp: offer.sdp },
          from: myPeerId,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("Renegotiation offer failed:", err);
    } finally {
      peerEntry.makingOffer = false;
    }
  };

  let disconnectedTimer = null;

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;

    if (state === "failed" || state === "closed") {
      console.warn("ICE connection lost:", remoteId, state);
      disconnectPeer(remoteId);
      return;
    }

    if (state === "disconnected") {
      clearTimeout(disconnectedTimer);

      // Give WebRTC a few seconds to recover before removing the user.
      disconnectedTimer = setTimeout(() => {
        if (pc.iceConnectionState === "disconnected") {
          console.warn("Peer stayed disconnected:", remoteId);
          disconnectPeer(remoteId);
        }
      }, 8000);
    }

    if (state === "connected" || state === "completed") {
      clearTimeout(disconnectedTimer);
      disconnectedTimer = null;
    }
  };

  try {
    peerEntry.unsubs.push(
      onSnapshot(
        signalRef,
        async (snap) => {
          const data = snap.data();
          if (!data) return;

          try {
            if (data.offer && data.from !== myPeerId) {
              const offerCollision =
                data.offer.type === "offer" &&
                (peerEntry.makingOffer || pc.signalingState !== "stable");
              if (!polite && offerCollision) return; // impolite side ignores a colliding offer

              if (offerCollision) {
                await pc.setLocalDescription({ type: "rollback" });
              }
              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              await flushPendingCandidates(peerEntry);

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await updateDoc(signalRef, {
                answer: { type: answer.type, sdp: answer.sdp },
              });
            } else if (data.answer && pc.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              await flushPendingCandidates(peerEntry);
            }
          } catch (err) {
            console.error("Signaling error with a peer:", err);
          }
        },
        (err) => {
          console.error("Signal listener error:", err);
          showToast("Signaling connection dropped for a participant.");
        }
      )
    );

    peerEntry.unsubs.push(
      onSnapshot(
        candidatesCol,
        (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type !== "added") return;
            const data = change.doc.data();
            if (data.from === myPeerId) return;
            addIceCandidateSafe(peerEntry, data);
          });
        },
        (err) => console.error("Candidate listener error:", err)
      )
    );
  } catch (err) {
    console.error("Failed to connect to peer", remoteId, err);
    showToast("Couldn't connect to a participant. They may need to rejoin.");
    disconnectPeer(remoteId);
  }
}

// Adds an already-active screen share's video (and audio, if shared) to one
// peer connection as a brand-new, separate transceiver rather than
// replacing the camera track - this is what makes it possible for the
// camera tile and the screen tile to be visible to everyone at once.
// Triggers pc.onnegotiationneeded automatically.
function attachScreenTrackToPeer(peerEntry, screenTrack, screenAudioTrack) {
  if (!screenTrack || peerEntry.screenVideoSender) return;
  const group = new MediaStream();
  peerEntry.screenVideoSender = peerEntry.pc.addTrack(screenTrack, group);
  if (screenAudioTrack) {
    peerEntry.screenAudioSender = peerEntry.pc.addTrack(screenAudioTrack, group);
  }
}

function detachScreenTrackFromPeer(peerEntry) {
  if (peerEntry.screenVideoSender) {
    try {
      peerEntry.pc.removeTrack(peerEntry.screenVideoSender);
    } catch (err) {
      /* connection may already be closed - fine */
    }
    peerEntry.screenVideoSender = null;
  }
  if (peerEntry.screenAudioSender) {
    try {
      peerEntry.pc.removeTrack(peerEntry.screenAudioSender);
    } catch (err) {
      /* connection may already be closed - fine */
    }
    peerEntry.screenAudioSender = null;
  }
}

// Routes an incoming track to either a peer's camera+mic tile or their
// separate screen tile, based on which outgoing MediaStream group it was
// sent under (see attachScreenTrackToPeer) - not on track order, since
// audio/video can arrive as separate ontrack events in either order.
function handleRemoteTrack(remoteId, peerEntry, event) {
  const track = event.track;
  const stream = event.streams[0] || null;

  if (peerEntry.primaryStreamId === null) {
    peerEntry.primaryStreamId = stream ? stream.id : null;
  }
  const isPrimary = !stream || stream.id === peerEntry.primaryStreamId;

  if (isPrimary) {
    if (!peerEntry.stream.getTracks().includes(track)) {
      peerEntry.stream.addTrack(track);
    }
    if (!peerEntry.tileEl) {
      peerEntry.tileEl = createTile(remoteId, { isLocal: false });
      const videoEl = peerEntry.tileEl.querySelector("video");
      videoEl.srcObject = peerEntry.stream;
      // Playback runs through the Web Audio gain graph (see
      // ensureTileAudioGraph) so the per-tile Volume slider works - keep the
      // <video> element itself muted or its audio would play twice.
      videoEl.muted = true;
    }
    setTileStreamVisible(peerEntry.tileEl, true);

    if (track.kind === "audio") {
      ensureTileAudioGraph(peerEntry.tileEl, peerEntry.stream, remoteId);
    }
    return;
  }

  // Anything not on the primary stream is this peer's screen share.
  if (!peerEntry.screenStream) peerEntry.screenStream = new MediaStream();
  if (!peerEntry.screenStream.getTracks().includes(track)) {
    peerEntry.screenStream.addTrack(track);
  }
  if (!peerEntry.screenTileEl) {
    peerEntry.screenTileEl = createTile(remoteId, { isLocal: false, isScreen: true });
    const screenVideoEl = peerEntry.screenTileEl.querySelector("video");
    screenVideoEl.srcObject = peerEntry.screenStream;
    screenVideoEl.muted = true;
    setTileStreamVisible(peerEntry.screenTileEl, true);
    setTileScreenShareState(peerEntry.screenTileEl, true, peerEntry.screenStream.getAudioTracks().length > 0);
  }

  if (track.kind === "audio") {
    ensureTileAudioGraph(peerEntry.screenTileEl, peerEntry.screenStream, remoteId);
  }

  // When they stop sharing, this track ends - clean up its tile once every
  // track from that share is gone.
  track.addEventListener("ended", () => {
    if (!peerEntry.screenStream) return;
    peerEntry.screenStream.removeTrack(track);
    if (peerEntry.screenStream.getTracks().length === 0 && peerEntry.screenTileEl) {
      removeTile(peerEntry.screenTileEl);
      peerEntry.screenTileEl = null;
      peerEntry.screenStream = null;
    }
  });
}

function disconnectPeer(remoteId) {
  const peerEntry = peers.get(remoteId);
  if (!peerEntry) return;

  peerEntry.unsubs.forEach((unsub) => unsub());
  peerEntry.pc.close();
  removeTile(peerEntry.tileEl);
  if (peerEntry.screenTileEl) removeTile(peerEntry.screenTileEl);
  peers.delete(remoteId);

  // Best-effort cleanup of the signaling doc for this pair.
  const pid = pairId(myPeerId, remoteId);
  deleteDoc(doc(collection(roomRef, "signals"), pid)).catch((err) =>
    console.warn("Signal doc cleanup failed (non-critical):", err)
  );
}

/* =========================================================================
   4. Media setup
   ========================================================================= */

async function setupMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast(
      "This browser can't access the camera/mic here - try HTTPS or a different browser."
    );
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localTile = createTile(myPeerId, { isLocal: true });
    localTile.querySelector("video").srcObject = localStream;
    setTileStreamVisible(localTile, true);
    updateLocalVideoMirror();

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.classList.add("active");

    await updateFlipCameraVisibility();
  } catch (err) {
    console.error("Could not access camera/microphone:", err);
    showToast(
      err.name === "NotAllowedError"
        ? "Camera/microphone permission was denied. Enable it in your browser settings and try again."
        : "Camera and microphone access is required to start a call."
    );
  }
}

copyLink.onclick = async () => {
  const currentId = callInput.value.trim();

  if (!currentId) {
    showToast("There's no call ID to copy yet - start or join a call first.", "info");
    return;
  }

  try {
    const link = `${window.location.origin}${window.location.pathname}?call=${currentId}`;
    await navigator.clipboard.writeText(link);

    const icon = copyLink.querySelector("i");
    const originalClass = icon.className;
    icon.className = "fa-solid fa-check";
    setTimeout(() => {
      icon.className = originalClass;
    }, 1500);
  } catch (err) {
    console.error("Failed to copy call link to clipboard:", err);
    showToast("Couldn't copy the link - your browser may be blocking clipboard access.");
  }
};

webcamButton.onclick = async () => {
  if (!localStream) {
    await setupMedia();
    return;
  }
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((track) => (track.enabled = camEnabled));
  webcamButton.classList.toggle("off", !camEnabled);
  webcamButton.classList.toggle("active", camEnabled);
  setTileStreamVisible(localTile, camEnabled);

  // Camera state changing mid-share flips between "camera + separate screen
  // tile" and "single tile showing just the screen" (see requirement #1).
  if (screenStream) {
    if (camEnabled) {
      enterTwoTileScreenShare();
    } else {
      collapseToSingleTileScreenShare();
    }
  }
};

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();

  const touchPresence = async () => {
    if (!inCall || !peersColRef) return;

    try {
      await updateDoc(doc(peersColRef, myPeerId), {
        lastSeenAt: serverTimestamp(),
        micEnabled,
      });
    } catch (err) {
      console.warn("Presence heartbeat failed:", err);
    }
  };

  touchPresence();
  presenceHeartbeatTimer = setInterval(
    touchPresence,
    PRESENCE_HEARTBEAT_MS
  );
}

function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }
}

function startPresenceCleanup() {
  stopPresenceCleanup();

  const checkStalePeers = () => {
    if (!inCall) return;

    const now = Date.now();

    for (const [peerId, peerEntry] of peers) {
      if (
        peerEntry.lastSeenMs &&
        now - peerEntry.lastSeenMs > PRESENCE_TIMEOUT_MS
      ) {
        console.warn("Removing stale peer:", peerId);
        disconnectPeer(peerId);
      }
    }
  };

  presenceCleanupTimer = setInterval(
    checkStalePeers,
    PRESENCE_HEARTBEAT_MS
  );
}

function stopPresenceCleanup() {
  if (presenceCleanupTimer) {
    clearInterval(presenceCleanupTimer);
    presenceCleanupTimer = null;
  }
}

function updatePeerPresence(peerId, data) {
  const peerEntry = peers.get(peerId);
  if (!peerEntry) return;

  const timestamp = data?.lastSeenAt;

  if (timestamp?.toMillis) {
    peerEntry.lastSeenMs = timestamp.toMillis();
  } else if (typeof timestamp === "number") {
    peerEntry.lastSeenMs = timestamp;
  }
}

async function joinRoom() {
  peersColRef = collection(roomRef, "peers");
  const myPeerRef = doc(peersColRef, myPeerId);

  try {
    await setDoc(myPeerRef, {
      joinedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      micEnabled,
      sharingScreen: false,
      sharingScreenAudio: false,
      sharingScreenSeparateTile: false,
    });
  } catch (err) {
    console.error("Failed to register in room:", err);
    showToast("Couldn't join the call - check your connection and try again.");
    return;
  }

  const knownRemotePeers = new Set();

  unsubPeers = onSnapshot(
    peersColRef,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const peerId = change.doc.id;
        if (peerId === myPeerId) return;

        if (change.type === "added") {
          if (knownRemotePeers.has(peerId)) return;
          knownRemotePeers.add(peerId);
          connectToPeer(peerId);
        } else if (change.type === "modified") {
          const data = change.doc.data();
          updatePeerPresence(peerId, data);
          const peerEntry = peers.get(peerId);
          if (peerEntry?.tileEl) {
            setTileMicState(peerEntry.tileEl, data.micEnabled !== false);
            // In two-tile mode the dedicated screen tile tracks its own
            // sharing state directly off the incoming WebRTC tracks (see
            // handleRemoteTrack) - the camera tile itself isn't "the share"
            // so it should never show as sharing there.
            if (!data.sharingScreenSeparateTile) {
              setTileScreenShareState(
                peerEntry.tileEl,
                !!data.sharingScreen,
                !!data.sharingScreenAudio
              );
            } else if (peerEntry.tileEl.dataset.sharingScreen === "true") {
              setTileScreenShareState(peerEntry.tileEl, false, false);
            }
          }
        } else if (change.type === "removed") {
          knownRemotePeers.delete(peerId);
          disconnectPeer(peerId);
        }
      });
    },
    (err) => {
      console.error("Room listener error:", err);
      showToast("Lost the connection to the call - try rejoining.");
    }
  );

  setInCallState();
  startPresenceHeartbeat();
  startPresenceCleanup();

  await requestWakeLock();
  startBackgroundAudioKeepAlive();
}

callButton.onclick = async () => {
  if (!localStream) await setupMedia();
  if (!localStream) return;

  try {
    roomId = doc(collection(firestore, "rooms")).id;
    callInput.value = roomId;
    callInput.readOnly = true;

    roomRef = doc(firestore, "rooms", roomId);
    await setDoc(roomRef, { createdAt: serverTimestamp(), hostPeerId: myPeerId });

    await joinRoom();
  } catch (err) {
    console.error("Failed to start call:", err);
    showToast("Couldn't start the call. Please try again.");
    callInput.readOnly = false;
  }
};

answerButton.onclick = async () => {
  const id = callInput.value.trim();
  if (!id) {
    showToast("Paste a call ID to join.", "info");
    return;
  }
  if (!localStream) await setupMedia();
  if (!localStream) return;

  try {
    const ref = doc(firestore, "rooms", id);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      showToast("Call not found. Check the call ID and try again.");
      return;
    }

    roomId = id;
    roomRef = ref;
    callInput.readOnly = true;

    await joinRoom();
  } catch (err) {
    console.error("Failed to join call:", err);
    showToast("Couldn't join that call. Please try again.");
  }
};

function setInCallState() {
  inCall = true;
  hangupButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
  copyLink.disabled = false;
  updateParticipantCount();
}

micButton.onclick = () => {
    if (!localStream) {
    showToast("Turn on your camera first.", "info");
    return;
  }
  
  if (!localStream) return;

  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => (track.enabled = micEnabled));
  micButton.classList.toggle("off", !micEnabled);
  setTileMicState(localTile, micEnabled);

  if (inCall && peersColRef) {
    updateDoc(doc(peersColRef, myPeerId), { micEnabled }).catch((err) =>
      console.warn("Failed to broadcast mic state (non-critical):", err)
    );
  }
};

async function updateFlipCameraVisibility() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    flipcamButton.style.display = "none";
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === "videoinput");
    flipcamButton.style.display = videoInputs.length > 1 ? "inline-flex" : "none";
  } catch (err) {
    console.error("Error enumerating devices:", err);
    flipcamButton.style.display = "none";
  }
}

let isFlipping = false;

flipcamButton.onclick = async () => {
  if (!localStream || isFlipping) return;

  isFlipping = true;
  flipcamButton.disabled = true; // Prevent rapid spamming

  const oldFacingMode = currentFacingMode;
  const newFacingMode = oldFacingMode === 'user' ? 'environment' : 'user';

  // Grab existing video track and its name/label
  const oldVideoTrack = localStream.getVideoTracks()[0];
  const oldCameraLabel = oldVideoTrack ? oldVideoTrack.label : "";

  try {
    // 1. Stop the old track FIRST (Required for iOS / Mobile Android)
    if (oldVideoTrack) {
      oldVideoTrack.stop();
      localStream.removeTrack(oldVideoTrack);
    }

    // 2. Request the new camera stream
    const newVideoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: newFacingMode } } // Fallback to flexible facingMode if exact fails
    }).catch(() => {
      // Retry without 'exact' in case device doesn't strictly support the mode string
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacingMode }
      });
    });

    const newVideoTrack = newVideoStream.getVideoTracks()[0];

    // --- NEW LOGIC: Check if the browser cheated ---
    // If the new camera has the exact same name as the old one, it didn't actually flip.
    if (oldCameraLabel && newVideoTrack.label === oldCameraLabel && newVideoTrack.label !== "") {
      throw new Error("Browser ignored facingMode and returned the same camera.");
    }
    // -----------------------------------------------

    // 3. Inherit current mute/enabled state
    newVideoTrack.enabled = camEnabled;

    // 4. Attach new track to local stream
    localStream.addTrack(newVideoTrack);

    // 5. Refresh local video element playback
    if (localTile) {
      const videoEl = localTile.querySelector("video");
      if (videoEl) {
        videoEl.srcObject = localStream;
        videoEl.play().catch(() => {});
      }
    }

    // 6. Update WebRTC peer senders safely
    const replacePromises = [];
    for (const [, { pc }] of peers) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        replacePromises.push(sender.replaceTrack(newVideoTrack));
      }
    }
    await Promise.allSettled(replacePromises);

    // Success
    currentFacingMode = newFacingMode;
    updateLocalVideoMirror();
    flipErrorCount = 0;
    showToast("Camera flipped successfully", "info");
    
  } catch (err) {
    console.error("Error flipping camera, attempting rollback:", err);
    
    // --- ERROR TRACKING ---
    flipErrorCount++; 
    
    // Hide the button ONLY if it has failed 2 or more times
    if (flipErrorCount >= 2) {
      flipcamButton.style.display = "none";
      console.warn("Camera flip failed 2 times in a row. Hiding button.");
    }

    // ROLLBACK: Try to restore the original camera if new one failed
    try {
      const rollbackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: oldFacingMode }
      });
      const rollbackTrack = rollbackStream.getVideoTracks()[0];
      rollbackTrack.enabled = camEnabled;
      
      localStream.addTrack(rollbackTrack);
      peers.forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) sender.replaceTrack(rollbackTrack);
      });
      updateLocalVideoMirror();
    } catch (rollbackErr) {
      console.error("Failed to recover previous camera track:", rollbackErr);
    }

    showToast("Could not switch camera.", "error"); // Changed from alert() for better UI
  } finally {
    isFlipping = false;
    flipcamButton.disabled = false;
  }
};

/* =========================================================================
   5. Screen share
   ---------------------------------------------------------------------*/

if (isMobileUA()) {
  sharescreenButton.disabled = true;
  sharescreenButton.classList.add("unsupported");
  sharescreenButton.title =
    "Screen sharing isn't supported by mobile browsers yet - use a desktop browser (Chrome, Edge, or Firefox) to share your screen.";
} else if (!isDisplayCaptureSupported()) {
  sharescreenButton.disabled = true;
  sharescreenButton.classList.add("unsupported");
  sharescreenButton.title = "Screen sharing isn't supported in this browser.";
}

sharescreenButton.onclick = async () => {
  if (sharescreenButton.disabled) return;

  if (!localStream) {
    showToast("Turn on your camera first.", "info");
    return;
  }

  if (!screenStream) {
    if (!isDisplayCaptureSupported()) {
      showToast("Screen sharing isn't supported in this browser.");
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (err) {
      console.error("Screen share failed:", err);
      screenStream = null;
      if (err.name === "NotAllowedError") {
        showToast(
          isMobileUA()
            ? "Screen sharing isn't supported on mobile browsers yet."
            : "Screen share permission was denied."
        );
      } else {
        showToast("Couldn't start screen sharing: " + (err.message || err.name));
      }
      return;
    }

    try {
      const screenTrack = screenStream.getVideoTracks()[0];
      const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

      screenTrack.onended = () => stopScreenShare();
      if (screenAudioTrack) screenAudioTrack.onended = () => stopScreenShare();

      // Camera on -> split into two tiles (this tile keeps the camera, a
      // brand-new one carries the screen). Camera off -> just show the
      // screen in the one tile, exactly like before.
      if (camEnabled) {
        startTwoTileScreenShare(screenTrack, screenAudioTrack);
      } else {
        startSwapModeScreenShare(screenTrack, screenAudioTrack);
      }

      flipcamButton.disabled = true;
      sharescreenButton.classList.add("active");
      sharescreenButton.title = screenAudioTrack
        ? "Sharing screen with audio - click to stop"
        : "Sharing screen - click to stop";
    } catch (err) {
      console.error("Error wiring up screen share:", err);
      showToast("Screen share started but couldn't reach every participant.");
    }
  } else {
    stopScreenShare();
  }
};

// --- Camera ON while sharing: separate camera + screen tiles -------------
// The screen's video (+ audio, if shared) goes out as a brand-new
// transceiver on every peer connection instead of replacing the camera
// track, so both are visible to everyone at once.
function startTwoTileScreenShare(screenTrack, screenAudioTrack) {
  localScreenTile = createTile(myPeerId, { isLocal: true, isScreen: true });
  const screenVideoEl = localScreenTile.querySelector("video");
  screenVideoEl.srcObject = screenStream;
  screenVideoEl.muted = true;
  setTileStreamVisible(localScreenTile, true);
  setTileScreenShareState(localScreenTile, true, !!screenAudioTrack);

  Array.from(peers.values()).forEach((peerEntry) =>
    attachScreenTrackToPeer(peerEntry, screenTrack, screenAudioTrack)
  );

  if (inCall && peersColRef) {
    updateDoc(doc(peersColRef, myPeerId), {
      sharingScreen: true,
      sharingScreenAudio: !!screenAudioTrack,
      sharingScreenSeparateTile: true,
    }).catch((err) => console.warn("Failed to broadcast screen-share state:", err));
  }
}

// --- Camera OFF while sharing: the single tile just becomes the screen ---
// Same as the original behavior - the screen track (and a mixed mic+screen
// audio track, if system audio was shared) replace the camera's own
// senders, so there's only ever one outgoing video/audio pair.
function startSwapModeScreenShare(screenTrack, screenAudioTrack) {
  let outgoingAudioTrack = localStream.getAudioTracks()[0];
  if (screenAudioTrack) {
    outgoingAudioTrack = mixAudioStreams(localStream, screenAudioTrack);
  }

  Array.from(peers.values()).forEach(({ pc }) => {
    const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (videoSender) videoSender.replaceTrack(screenTrack);

    if (screenAudioTrack) {
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (audioSender && outgoingAudioTrack) audioSender.replaceTrack(outgoingAudioTrack);
    }
  });

  if (localTile) localTile.querySelector("video").srcObject = screenStream;
  updateLocalVideoMirror();
  setTileScreenShareState(localTile, true, !!screenAudioTrack);

  if (inCall && peersColRef) {
    updateDoc(doc(peersColRef, myPeerId), {
      sharingScreen: true,
      sharingScreenAudio: !!screenAudioTrack,
      sharingScreenSeparateTile: false,
    }).catch((err) => console.warn("Failed to broadcast screen-share state:", err));
  }
}

// Camera turned ON mid-share (was in swap mode) - move the camera/mic back
// onto their original senders and split the screen out into its own tile.
function enterTwoTileScreenShare() {
  if (localScreenTile || !screenStream) return;

  const screenTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    const micTrack = localStream.getAudioTracks()[0];
    Array.from(peers.values()).forEach(({ pc }) => {
      const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (videoSender && camTrack) videoSender.replaceTrack(camTrack);
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (audioSender && micTrack) audioSender.replaceTrack(micTrack);
    });
    if (localTile) localTile.querySelector("video").srcObject = localStream;
    updateLocalVideoMirror();
  }

  if (screenAudioMixCtx) {
    screenAudioMixCtx.close().catch(() => {});
    screenAudioMixCtx = null;
  }

  setTileScreenShareState(localTile, false, false);
  startTwoTileScreenShare(screenTrack, screenAudioTrack);
}

// Camera turned OFF mid-share (was in two-tile mode) - fold the screen back
// into the single tile and drop the dedicated screen transceiver.
function collapseToSingleTileScreenShare() {
  if (!localScreenTile || !screenStream) return;

  const screenTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

  Array.from(peers.values()).forEach((peerEntry) => detachScreenTrackFromPeer(peerEntry));

  removeTile(localScreenTile);
  localScreenTile = null;

  startSwapModeScreenShare(screenTrack, screenAudioTrack);
}

function stopScreenShare() {
  if (!screenStream) return;

  const wasTwoTileMode = !!localScreenTile;

  screenStream.getTracks().forEach((track) => track.stop());
  screenStream = null;
  flipcamButton.disabled = false;

  if (screenAudioMixCtx) {
    screenAudioMixCtx.close().catch(() => {});
    screenAudioMixCtx = null;
  }

  if (wasTwoTileMode) {
    Array.from(peers.values()).forEach((peerEntry) => detachScreenTrackFromPeer(peerEntry));
    removeTile(localScreenTile);
    localScreenTile = null;
  } else if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    const micTrack = localStream.getAudioTracks()[0];

    Array.from(peers.values()).forEach(({ pc }) => {
      const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (videoSender && camTrack) videoSender.replaceTrack(camTrack);
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (audioSender && micTrack) audioSender.replaceTrack(micTrack);
    });

    if (localTile) localTile.querySelector("video").srcObject = localStream;
    updateLocalVideoMirror();
    setTileScreenShareState(localTile, false, false);
  }

  sharescreenButton.classList.remove("active");
  sharescreenButton.title = "Share screen";

  if (inCall && peersColRef) {
    updateDoc(doc(peersColRef, myPeerId), {
      sharingScreen: false,
      sharingScreenAudio: false,
      sharingScreenSeparateTile: false,
    }).catch((err) => console.warn("Failed to broadcast screen-share state:", err));
  }
}

/* =========================================================================
   6. Hang up / cleanup
   ========================================================================= */

hangupButton.onclick = async () => {
  stopPresenceHeartbeat();
  stopPresenceCleanup();
  Array.from(peers.keys()).forEach((peerId) => disconnectPeer(peerId));

  if (unsubPeers) {
    unsubPeers();
    unsubPeers = null;
  }
  if (roomRef && peersColRef) {
    deleteDoc(doc(peersColRef, myPeerId)).catch((err) =>
      console.warn("Failed to remove self from room (non-critical):", err)
    );
  }

  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  screenStream = null;
  micEnabled = true;
  camEnabled = true;
  roomId = null;
  roomRef = null;
  peersColRef = null;
  inCall = false;
  nextTileNumber = 1;

  if (screenAudioMixCtx) {
    screenAudioMixCtx.close().catch(() => {});
    screenAudioMixCtx = null;
  }
  if (audioMixContext) {
    audioMixContext.close().catch(() => {});
    audioMixContext = null;
  }

  if (localScreenTile) {
    removeTile(localScreenTile);
    localScreenTile = null;
  }
  removeTile(localTile);
  localTile = null;
  callGrid.classList.remove("has-focus");
  pinnedTile = null;
  activeScreenShares.clear();
  participantVolume.clear();
  peerDisplayNumber.clear();

  callInput.value = "";
  callInput.readOnly = false;
  callButton.disabled = false;
  answerButton.disabled = false;
  hangupButton.disabled = true;
  copyLink.disabled = true;
  webcamButton.classList.remove("active", "off");
  micButton.classList.remove("off");
  sharescreenButton.classList.remove("active");
  sharescreenButton.title = "Share screen";
  updateParticipantCount();
  stopBackgroundAudioKeepAlive();
};

window.addEventListener("beforeunload", () => {
  stopPresenceHeartbeat();
  stopPresenceCleanup();
  if (inCall && peersColRef) {
    deleteDoc(doc(peersColRef, myPeerId)).catch(() => {});
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (localStream) {
    updateFlipCameraVisibility();
  }
});