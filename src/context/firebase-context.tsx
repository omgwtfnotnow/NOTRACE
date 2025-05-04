'use client';

import * as React from 'react';
import { initializeApp, getApp, getApps, type FirebaseApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';
// import { getAuth, type Auth } from 'firebase/auth'; // Uncomment if auth is needed later

// --- IMPORTANT: Replace with your actual Firebase configuration ---
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
// --- --- --- --- --- --- --- --- --- --- --- --- --- --- --- --- ---

interface FirebaseContextProps {
  app: FirebaseApp | null;
  db: Database | null;
//   auth: Auth | null; // Uncomment if auth is needed later
}

const FirebaseContext = React.createContext<FirebaseContextProps>({
  app: null,
  db: null,
//   auth: null, // Uncomment if auth is needed later
});

export const useFirebase = () => React.useContext(FirebaseContext);

export const FirebaseProvider = ({ children }: { children: React.ReactNode }) => {
  const [app, setApp] = React.useState<FirebaseApp | null>(null);
  const [db, setDb] = React.useState<Database | null>(null);
//   const [auth, setAuth] = React.useState<Auth | null>(null); // Uncomment if auth is needed later

  React.useEffect(() => {
    let firebaseApp: FirebaseApp;

    if (!getApps().length) {
      console.log("Initializing Firebase...");
      firebaseApp = initializeApp(firebaseConfig);
    } else {
      console.log("Using existing Firebase app...");
      firebaseApp = getApp();
    }

    const database = getDatabase(firebaseApp);
    // const authInstance = getAuth(firebaseApp); // Uncomment if auth is needed later

    setApp(firebaseApp);
    setDb(database);
    // setAuth(authInstance); // Uncomment if auth is needed later

    console.log("Firebase initialized:", firebaseApp.name);
    console.log("Database connected:", database.app.name);

  }, []);

  return (
    <FirebaseContext.Provider value={{ app, db /*, auth*/ }}>
      {children}
    </FirebaseContext.Provider>
  );
};
