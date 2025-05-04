// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAMulpBDJzY1Fe3NDF1bISU2jvdc4bBH98",
  authDomain: "notrace-a5cb1.firebaseapp.com",
  databaseURL: "https://notrace-a5cb1-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "notrace-a5cb1",
  storageBucket: "notrace-a5cb1.firebasestorage.app",
  messagingSenderId: "1077432488707",
  appId: "1:1077432488707:web:bb7a609a6f0c8aba194f36",
  measurementId: "G-BXR9R9PPBZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);