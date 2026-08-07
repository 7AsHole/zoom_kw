import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
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

const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

let pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;
let screenStream = null;
let micEnabled = true;
let camEnabled = true;

const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");
const micButton = document.getElementById("micButton");
const sharescreenButton = document.getElementById("sharescreenButton");
const localTile = document.getElementById("localTile");
const remoteTile = document.getElementById("remoteTile");

callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;

async function setupMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    remoteStream = new MediaStream();

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
      remoteTile.classList.add("has-stream");
    };

    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = remoteStream;
    localTile.classList.add("has-stream");

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.classList.add("active");
  } catch (err) {
    console.error("Could not access camera/microphone:", err);
    alert("Camera and microphone access is required to start a call.");
  }
}

webcamButton.onclick = async () => {
  if (!localStream) {
    await setupMedia();
    return;
  }
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((track) => (track.enabled = camEnabled));
  webcamButton.classList.toggle("off", !camEnabled);
};

callButton.onclick = async () => {
  if (!localStream) await setupMedia();
  if (!localStream) return;

  const callDoc = doc(collection(firestore, "calls"));
  const offerCandidates = collection(callDoc, "offerCandidates");
  const answerCandidates = collection(callDoc, "answerCandidates");

  callInput.value = callDoc.id;
  callInput.readOnly = true;

  pc.onicecandidate = (event) => {
    if (event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
  };

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  await setDoc(callDoc, {
    offer: { sdp: offerDescription.sdp, type: offerDescription.type },
  });

  onSnapshot(callDoc, (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });

  onSnapshot(answerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  setInCallState();
};

answerButton.onclick = async () => {
  const callId = callInput.value.trim();
  if (!callId) {
    alert("Paste a call ID to join.");
    return;
  }
  if (!localStream) await setupMedia();
  if (!localStream) return;

  const callDoc = doc(firestore, "calls", callId);
  const offerCandidates = collection(callDoc, "offerCandidates");
  const answerCandidates = collection(callDoc, "answerCandidates");

  pc.onicecandidate = (event) => {
    if (event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
  };

  const callSnapshot = await getDoc(callDoc);
  if (!callSnapshot.exists()) {
    alert("Call not found. Check the call ID and try again.");
    return;
  }

  const { offer } = callSnapshot.data();
  await pc.setRemoteDescription(new RTCSessionDescription(offer));

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  await updateDoc(callDoc, {
    answer: { type: answerDescription.type, sdp: answerDescription.sdp },
  });

  onSnapshot(offerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  callInput.readOnly = true;
  setInCallState();
};

function setInCallState() {
  hangupButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
}

micButton.onclick = () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => (track.enabled = micEnabled));
  micButton.classList.toggle("off", !micEnabled);
};

sharescreenButton.onclick = async () => {
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");

  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (sender) await sender.replaceTrack(screenTrack);
      webcamVideo.srcObject = screenStream;
      sharescreenButton.classList.add("active");
      screenTrack.onended = () => stopScreenShare(sender);
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  } else {
    stopScreenShare(sender);
  }
};

async function stopScreenShare(sender) {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    if (sender && camTrack) await sender.replaceTrack(camTrack);
    webcamVideo.srcObject = localStream;
  }
  sharescreenButton.classList.remove("active");
}

hangupButton.onclick = () => {
  pc.close();
  pc = new RTCPeerConnection(servers);

  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  remoteStream = null;
  screenStream = null;
  micEnabled = true;
  camEnabled = true;

  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;
  localTile.classList.remove("has-stream");
  remoteTile.classList.remove("has-stream");

  callInput.value = "";
  callInput.readOnly = false;
  callButton.disabled = false;
  answerButton.disabled = false;
  hangupButton.disabled = true;
  webcamButton.classList.remove("active", "off");
  micButton.classList.remove("off");
  sharescreenButton.classList.remove("active");
};
