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

const firebaseConfig = {
  apiKey: "AIzaSyDHWKvjrsDhjw12c6ZEb36ONST_PQXt7K8",
  authDomain: "zoomkw-c661b.firebaseapp.com",
  projectId: "zoomkw-c661b",
  storageBucket: "zoomkw-c661b.firebasestorage.app",
  messagingSenderId: "875237020278",
  appId: "1:875237020278:web:8933cdbb2e138950434557",
  measurementId: "G-1RWSGLEBGH",
};

const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

// Hard cap on participants in a single call (drives the 1x1 -> 3x3 grid).
const MAX_PEERS = 9;
let flipErrorCount = 0;
const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

// A random id that identifies *this browser tab* within a room. Every peer
// connects to every other peer directly (mesh topology), which is what lets
// us scale from a 1:1 call up to 9 people without a media server.
const myPeerId = crypto.randomUUID();

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

/* =========================================================================
   0. Small utilities: toasts + platform detection
   ---------------------------------------------------------------------
   These exist so that failures are always visible to the user instead of
   only landing in the console (see fixes #5 throughout this file). */

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
let nextTileNumber = 1; // "User 1" is always the local tile
let currentFacingMode = 'user';

// remotePeerId -> { pc, stream, tileEl, unsubs: [], pendingCandidates: [] }
const peers = new Map();

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

/* =========================================================================
   2. Grid helpers
   ========================================================================= */

function participantTotal() {
  return callGrid.children.length;
}

function updateParticipantCount() {
  const total = participantTotal();
  callGrid.dataset.count = String(Math.min(total, MAX_PEERS));

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

function setTileStreamVisible(tileEl, visible) {
  if (!tileEl) return;
  tileEl.classList.toggle("has-stream", visible);
}

// --- Dynamic "spotlight" grid scaling (requirement #2) -------------------
// Tapping a tile grows it to fill the main area while every other tile
// shrinks into a thumbnail strip. Tapping the same tile again restores the
// even grid. Only one tile can be focused at a time.
function toggleFocusTile(tile) {
  const alreadyFocused = tile.classList.contains("focused");
  callGrid
    .querySelectorAll(".participant-tile.focused")
    .forEach((t) => t.classList.remove("focused"));

  if (!alreadyFocused) {
    tile.classList.add("focused");
    callGrid.classList.add("has-focus");
  } else {
    callGrid.classList.remove("has-focus");
  }
}

function clearFocusIfNeeded(tile) {
  if (tile && tile.classList.contains("focused")) {
    callGrid.classList.remove("has-focus");
  }
}

// --- Per-tile digital zoom, local user only (requirement #3) -------------
// Only the local tile gets a zoom control, so nobody can zoom someone
// else's camera/screen - only their own. It's a CSS scale of the preview
// element itself, so it applies equally whether the local video is the
// webcam or an active screen share (same <video> element either way).
const ZOOM_LEVELS = [1, 1.5, 0.5];

function attachZoomControl(tile, video) {
  const zoomBtn = document.createElement("button");
  zoomBtn.type = "button";
  zoomBtn.className = "zoom-btn";
  zoomBtn.title = "Zoom your view";
  zoomBtn.setAttribute("aria-label", "Zoom your own camera or screen");
  zoomBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';

  let zoomIndex = 0;
  zoomBtn.addEventListener("click", (event) => {
    event.stopPropagation();

    zoomIndex = (zoomIndex + 1) % ZOOM_LEVELS.length;
    const level = ZOOM_LEVELS[zoomIndex];

    video.style.transform = level === 1 ? "" : `scale(${level})`;

    zoomBtn.classList.toggle("zoom-active", level > 1);
    zoomBtn.title =
      level > 1
        ? `Zoomed ${level}x — tap to change`
        : "Zoom video";
  });

  tile.appendChild(zoomBtn);
  return zoomBtn;
}

function createTile(peerId, { isLocal }) {
  const label = isLocal ? "You" : `User ${nextTileNumber}`;
  if (!isLocal) nextTileNumber += 1;

  const tile = document.createElement("div");
  tile.className = "participant-tile";
  tile.dataset.peerId = peerId;

  tile.addEventListener("click", (event) => {
    if (event.target.closest(".zoom-btn")) return; // handled separately
    toggleFocusTile(tile);
  });

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const avatar = document.createElement("div");
  avatar.className = "avatar" + (isLocal ? " local" : "");
  avatar.textContent = isLocal ? "U1" : `U${nextTileNumber - 1}`;

  const tag = document.createElement("div");
  tag.className = "tile-tag";

  const micIcon = document.createElement("i");
  micIcon.className = "mic-icon fa-solid fa-microphone active";

  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;

  tag.append(micIcon, nameSpan);
  tile.append(video, avatar, tag);

  // Only the tile owner can zoom their own camera/screen - never added to
  // remote tiles, so nobody else can control your view.
  attachZoomControl(tile, video); 

  callGrid.appendChild(tile);
  updateParticipantCount();

  return tile;
}

function removeTile(tileEl) {
  if (!tileEl) return;
  clearFocusIfNeeded(tileEl);
  if (tileEl.parentElement) tileEl.remove();
  updateParticipantCount();
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
  const peerEntry = {
    pc,
    stream: new MediaStream(),
    tileEl: null,
    unsubs: [],
    pendingCandidates: [],
  };
  peers.set(remoteId, peerEntry);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      if (!peerEntry.stream.getTracks().includes(track)) {
        peerEntry.stream.addTrack(track);
      }
    });
    if (!peerEntry.tileEl) {
      peerEntry.tileEl = createTile(remoteId, { isLocal: false });
      peerEntry.tileEl.querySelector("video").srcObject = peerEntry.stream;
    }
    setTileStreamVisible(peerEntry.tileEl, true);
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      console.error("ICE connection failed for peer:", remoteId);
      showToast("Lost the connection to a participant.");
    }
  };

  const pid = pairId(myPeerId, remoteId);
  const signalRef = doc(collection(roomRef, "signals"), pid);
  const offerCandidates = collection(signalRef, "offerCandidates");
  const answerCandidates = collection(signalRef, "answerCandidates");
  const amOfferer = myPeerId < remoteId;

  try {
    if (amOfferer) {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(offerCandidates, event.candidate.toJSON()).catch((err) =>
            console.error("Failed to send ICE candidate:", err)
          );
        }
      };

      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);
      await setDoc(
        signalRef,
        {
          offer: { sdp: offerDescription.sdp, type: offerDescription.type },
          from: myPeerId,
        },
        { merge: true }
      );

      peerEntry.unsubs.push(
        onSnapshot(
          signalRef,
          async (snap) => {
            const data = snap.data();
            if (!pc.currentRemoteDescription && data?.answer) {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              await flushPendingCandidates(peerEntry);
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
          answerCandidates,
          (snap) => {
            snap.docChanges().forEach((change) => {
              if (change.type === "added") {
                addIceCandidateSafe(peerEntry, change.doc.data());
              }
            });
          },
          (err) => console.error("Answer-candidate listener error:", err)
        )
      );
    } else {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(answerCandidates, event.candidate.toJSON()).catch((err) =>
            console.error("Failed to send ICE candidate:", err)
          );
        }
      };

      peerEntry.unsubs.push(
        onSnapshot(
          signalRef,
          async (snap) => {
            const data = snap.data();
            if (!data?.offer || pc.currentRemoteDescription) return;
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            await flushPendingCandidates(peerEntry);

            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            await updateDoc(signalRef, {
              answer: { type: answerDescription.type, sdp: answerDescription.sdp },
            });
          },
          (err) => {
            console.error("Signal listener error:", err);
            showToast("Signaling connection dropped for a participant.");
          }
        )
      );

      peerEntry.unsubs.push(
        onSnapshot(
          offerCandidates,
          (snap) => {
            snap.docChanges().forEach((change) => {
              if (change.type === "added") {
                addIceCandidateSafe(peerEntry, change.doc.data());
              }
            });
          },
          (err) => console.error("Offer-candidate listener error:", err)
        )
      );
    }
  } catch (err) {
    console.error("Failed to connect to peer", remoteId, err);
    showToast("Couldn't connect to a participant. They may need to rejoin.");
    disconnectPeer(remoteId);
  }
}

function disconnectPeer(remoteId) {
  const peerEntry = peers.get(remoteId);
  if (!peerEntry) return;

  peerEntry.unsubs.forEach((unsub) => unsub());
  peerEntry.pc.close();
  removeTile(peerEntry.tileEl);
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
};

async function joinRoom() {
  peersColRef = collection(roomRef, "peers");
  const myPeerRef = doc(peersColRef, myPeerId);

  try {
    await setDoc(myPeerRef, {
      joinedAt: serverTimestamp(),
      micEnabled,
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
          const peerEntry = peers.get(peerId);
          if (peerEntry?.tileEl) {
            setTileMicState(peerEntry.tileEl, data.micEnabled !== false);
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
    showToast("Turn on your camera/mic first.", "info");
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

      Array.from(peers.values()).forEach(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack).catch((err) => {
          console.error("Failed to send screen share to a peer:", err);
        });
      });

      if (localTile) localTile.querySelector("video").srcObject = screenStream;
      flipcamButton.disabled = true;
      sharescreenButton.classList.add("active");
      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error("Error wiring up screen share:", err);
      showToast("Screen share started but couldn't reach every participant.");
    }
  } else {
    stopScreenShare();
  }
};

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
    flipcamButton.disabled = false;
  }
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    Array.from(peers.values()).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && camTrack) {
        sender.replaceTrack(camTrack).catch((err) =>
          console.error("Failed to restore camera track for a peer:", err)
        );
      }
    });
    if (localTile) localTile.querySelector("video").srcObject = localStream;
  }
  sharescreenButton.classList.remove("active");
}

/* =========================================================================
   6. Hang up / cleanup
   ========================================================================= */

hangupButton.onclick = async () => {
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

  removeTile(localTile);
  localTile = null;
  callGrid.classList.remove("has-focus");

  callInput.value = "";
  callInput.readOnly = false;
  callButton.disabled = false;
  answerButton.disabled = false;
  hangupButton.disabled = true;
  copyLink.disabled = true;
  webcamButton.classList.remove("active", "off");
  micButton.classList.remove("off");
  sharescreenButton.classList.remove("active");
  updateParticipantCount();
  stopBackgroundAudioKeepAlive();
};

window.addEventListener("beforeunload", () => {
  if (inCall && peersColRef) {
    deleteDoc(doc(peersColRef, myPeerId)).catch(() => {});
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (localStream) {
    updateFlipCameraVisibility();
  }
});