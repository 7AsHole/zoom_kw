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

function createTile(peerId, { isLocal }) {
  const label = isLocal ? "You" : `User ${nextTileNumber}`;
  if (!isLocal) nextTileNumber += 1;

  const tile = document.createElement("div");
  tile.className = "participant-tile";
  tile.dataset.peerId = peerId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const avatar = document.createElement("div");
  avatar.className = "avatar" + (isLocal ? " local" : "");
  avatar.textContent = isLocal
    ? "U1"
    : `U${nextTileNumber - 1}`;

  const tag = document.createElement("div");
  tag.className = "tile-tag";

  const micIcon = document.createElement("i");
  micIcon.className = "mic-icon fa-solid fa-microphone active";

  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;

  tag.append(micIcon, nameSpan);
  tile.append(video, avatar, tag);
  callGrid.appendChild(tile);
  updateParticipantCount();

  return tile;
}

function removeTile(tileEl) {
  if (tileEl && tileEl.parentElement) tileEl.remove();
  updateParticipantCount();
}

function pairId(a, b) {
  return [a, b].sort().join("_");
}

// ICE candidates can arrive over Firestore before the remote SDP has been
// applied. Queue them per-peer and flush once setRemoteDescription resolves.
async function addIceCandidateSafe(peerEntry, candidateData) {
  const { pc } = peerEntry;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (err) {
      console.error("Failed to add ICE candidate:", err);
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

  const pid = pairId(myPeerId, remoteId);
  const signalRef = doc(collection(roomRef, "signals"), pid);
  const offerCandidates = collection(signalRef, "offerCandidates");
  const answerCandidates = collection(signalRef, "answerCandidates");
  const amOfferer = myPeerId < remoteId;

  if (amOfferer) {
    pc.onicecandidate = (event) => {
      if (event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
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
      onSnapshot(signalRef, async (snap) => {
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          await flushPendingCandidates(peerEntry);
        }
      })
    );

    peerEntry.unsubs.push(
      onSnapshot(answerCandidates, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            addIceCandidateSafe(peerEntry, change.doc.data());
          }
        });
      })
    );
  } else {
    pc.onicecandidate = (event) => {
      if (event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
    };

    peerEntry.unsubs.push(
      onSnapshot(signalRef, async (snap) => {
        const data = snap.data();
        if (!data?.offer || pc.currentRemoteDescription) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await flushPendingCandidates(peerEntry);

        const answerDescription = await pc.createAnswer();
        await pc.setLocalDescription(answerDescription);
        await updateDoc(signalRef, {
          answer: { type: answerDescription.type, sdp: answerDescription.sdp },
        });
      })
    );

    peerEntry.unsubs.push(
      onSnapshot(offerCandidates, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            addIceCandidateSafe(peerEntry, change.doc.data());
          }
        });
      })
    );
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
  deleteDoc(doc(collection(roomRef, "signals"), pid)).catch(() => {});
}

async function setupMedia() {
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
  } catch (err) {
    console.error("Could not access camera/microphone:", err);
    alert("Camera and microphone access is required to start a call.");
  }
}



copyLink.onclick = async () => {
  const currentId = callInput.value.trim();

  if (!currentId) {
    alert("There is no Call ID to copy yet! Click 'Call' to generate one first.");
    return;
  }

  try {
    const link = `${window.location.origin}${window.location.pathname}?call=${currentId}`;
    await navigator.clipboard.writeText(link);
    console.log("Call link copied to clipboard successfully!");

    const icon = copyLink.querySelector("i");
    const originalClass = icon.className;
    icon.className = "fa-solid fa-check";
    setTimeout(() => {
      icon.className = originalClass;
    }, 1500);
  } catch (err) {
    console.error("Failed to copy call link to clipboard:", err);
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

  await setDoc(myPeerRef, {
    joinedAt: serverTimestamp(),
    micEnabled,
  });

  const knownRemotePeers = new Set();

  unsubPeers = onSnapshot(peersColRef, (snapshot) => {
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
  });

  setInCallState();
}

callButton.onclick = async () => {
  if (!localStream) await setupMedia();
  if (!localStream) return;

  roomId = doc(collection(firestore, "rooms")).id;
  callInput.value = roomId;
  callInput.readOnly = true;

  roomRef = doc(firestore, "rooms", roomId);
  await setDoc(roomRef, { createdAt: serverTimestamp(), hostPeerId: myPeerId });

  await joinRoom();
};

answerButton.onclick = async () => {
  const id = callInput.value.trim();
  if (!id) {
    alert("Paste a call ID to join.");
    return;
  }
  if (!localStream) await setupMedia();
  if (!localStream) return;

  const ref = doc(firestore, "rooms", id);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    alert("Call not found. Check the call ID and try again.");
    return;
  }

  roomId = id;
  roomRef = ref;
  callInput.readOnly = true;

  await joinRoom();
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
    updateDoc(doc(peersColRef, myPeerId), { micEnabled }).catch(() => {});
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

// This is where the actual flip (steps 4–7 from before) belongs.
flipcamButton.onclick = async () => {
  if (!localStream) return;
  // getUserMedia with the toggled facingMode, swap the track, replaceTrack on each peer...
};

sharescreenButton.onclick = async () => {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      // Swap the outgoing video track on every active peer connection.
      peers.forEach(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      });

      localTile.querySelector("video").srcObject = screenStream;
      sharescreenButton.classList.add("active");
      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  } else {
    stopScreenShare();
  }
};

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
    if (localTile) localTile.querySelector("video").srcObject = localStream;
  }
  sharescreenButton.classList.remove("active");
}

hangupButton.onclick = async () => {
  // Tear down every mesh connection and remove remote tiles.
  Array.from(peers.keys()).forEach((peerId) => disconnectPeer(peerId));

  if (unsubPeers) {
    unsubPeers();
    unsubPeers = null;
  }
  if (roomRef) {
    deleteDoc(doc(peersColRef, myPeerId)).catch(() => {});
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
};

window.addEventListener("beforeunload", () => {
  if (inCall && peersColRef) {
    deleteDoc(doc(peersColRef, myPeerId)).catch(() => {});
  }
});