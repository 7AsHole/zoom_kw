import firebase from "firebase/app";
import "firebase/firestore";
import "./zoom_kw.css";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDHWKvjrsDhjw12c6ZEb36ONST_PQXt7K8",
  authDomain: "zoomkw-c661b.firebaseapp.com",
  projectId: "zoomkw-c661b",
  storageBucket: "zoomkw-c661b.firebasestorage.app",
  messagingSenderId: "875237020278",
  appId: "1:875237020278:web:8933cdbb2e138950434557",
  measurementId: "G-1RWSGLEBGH"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const firestore = firebase.firestore(); 

//global state

let pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;

const w