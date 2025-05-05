'use client';

import * as React from 'react';
import { initializeApp, getApp, getApps, type FirebaseApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';
// import { getAuth, type Auth } from 'firebase/auth'; // Uncomment if auth is needed later

// --- IMPORTANT: Ensure these environment variables are set in your deployment environment (e.g., Vercel) ---
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

// Function to validate the Firebase config
const validateFirebaseConfig = (config: typeof firebaseConfig): string[] => {
  const missingKeys: string[] = [];
  // Add required keys here. Project ID and Database URL are often crucial.
  const requiredKeys: (keyof typeof firebaseConfig)[] = [
    'apiKey',
    'authDomain',
    'databaseURL', // Crucial for Realtime Database
    'projectId',   // Crucial for Database URL determination if databaseURL is missing/invalid format
    'storageBucket',
    'messagingSenderId',
    'appId',
  ];

  for (const key of requiredKeys) {
    if (!config[key]) {
      missingKeys.push(`NEXT_PUBLIC_FIREBASE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
    }
  }
  return missingKeys;
};


interface FirebaseContextProps {
  app: FirebaseApp | null;
  db: Database | null;
//   auth: Auth | null; // Uncomment if auth is needed later
  error: string | null; // Add error state
}

const FirebaseContext = React.createContext<FirebaseContextProps>({
  app: null,
  db: null,
//   auth: null, // Uncomment if auth is needed later
  error: null,
});

export const useFirebase = () => React.useContext(FirebaseContext);

export const FirebaseProvider = ({ children }: { children: React.ReactNode }) => {
  const [app, setApp] = React.useState<FirebaseApp | null>(null);
  const [db, setDb] = React.useState<Database | null>(null);
//   const [auth, setAuth] = React.useState<Auth | null>(null); // Uncomment if auth is needed later
  const [error, setError] = React.useState<string | null>(null); // State to hold initialization error

  React.useEffect(() => {
    // Validate the config first
    const missingConfigKeys = validateFirebaseConfig(firebaseConfig);
    if (missingConfigKeys.length > 0) {
      const errorMsg = `Firebase initialization failed: Missing required environment variables: ${missingConfigKeys.join(', ')}. Please ensure these are set in your Vercel deployment settings.`;
      console.error(errorMsg);
      setError(errorMsg); // Set error state
      setApp(null); // Ensure app and db are null
      setDb(null);
      return; // Stop initialization
    }

    let firebaseApp: FirebaseApp;
    try {
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
      setError(null); // Clear any previous error

      console.log("Firebase initialized:", firebaseApp.name);
      console.log("Database connected:", database.app.name);

    } catch (initError: any) {
        const errorMsg = `Firebase initialization error: ${initError.message}. Please check your Firebase config and Vercel environment variables.`;
        console.error(errorMsg, initError);
        setError(errorMsg);
        setApp(null);
        setDb(null);
    }

  }, []); // Run only once on mount

  return (
    <FirebaseContext.Provider value={{ app, db, error /*, auth*/ }}>
      {children}
    </FirebaseContext.Provider>
  );
};
