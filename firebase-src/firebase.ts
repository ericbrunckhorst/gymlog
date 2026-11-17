import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA-Oqd48akMdZNZ456W0Cwe8x9lT-IlBsg",
  authDomain: "gymlog-9ed9d.firebaseapp.com",
  projectId: "gymlog-9ed9d",
  storageBucket: "gymlog-9ed9d.firebasestorage.app",
  messagingSenderId: "247507544255",
  appId: "1:247507544255:web:2b9816a0be947dec49fe0a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
