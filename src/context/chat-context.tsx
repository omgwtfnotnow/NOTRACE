'use client';

import * as React from 'react';
import {
  getDatabase,
  ref,
  set,
  onValue,
  push,
  remove,
  serverTimestamp,
  runTransaction,
  onDisconnect,
  update,
  off,
  get,
  DatabaseReference,
} from 'firebase/database';
import { useFirebase } from './firebase-context';
import { generateRandomName } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

const MAX_MEMBERS = 8; // Define maximum members for a room
const MEMBER_INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

export interface Message {
  id?: string;
  senderId: string;
  text: string;
  timestamp: number | object; // Can be number or Firebase ServerValue.TIMESTAMP
}

export interface Member {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | object; // Timestamp for inactivity check
}

interface ChatContextProps {
  messages: Message[];
  members: Member[];
  currentUser: Member | null;
  loading: boolean;
  error: string | null;
  roomExists: (roomCode: string) => Promise<boolean>;
  createRoom: (roomCode: string) => Promise<void>;
  joinRoom: (roomCode: string) => Promise<boolean>; // Returns true if successful, false otherwise
  leaveRoom: (roomCode: string) => Promise<void>;
  sendMessage: (roomCode: string, text: string) => Promise<void>;
  checkRoomExists: (roomCode: string) => Promise<boolean>; // Added explicit check function
}

const ChatContext = React.createContext<ChatContextProps>({
  messages: [],
  members: [],
  currentUser: null,
  loading: true,
  error: null,
  roomExists: async () => false,
  createRoom: async () => {},
  joinRoom: async () => false,
  leaveRoom: async () => {},
  sendMessage: async () => {},
  checkRoomExists: async () => false, // Added default
});

export const useChat = () => React.useContext(ChatContext);

export const ChatProvider = ({ children }: { children: React.ReactNode }) => {
  const { db } = useFirebase();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [currentUser, setCurrentUser] = React.useState<Member | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true); // Initially loading
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();
  const currentRoomCode = React.useRef<string | null>(null);
  const listenersRef = React.useRef<{ messages?: DatabaseReference; members?: DatabaseReference }>({});
  const joinAttemptRef = React.useRef<number>(0); // Ref to track join attempts


  // --- Utility Functions ---

  const getRoomRef = React.useCallback((roomCode: string) => {
    if (!db) throw new Error("Database not initialized");
    return ref(db, `rooms/${roomCode.toUpperCase()}`);
  }, [db]);

  const getMessagesRef = React.useCallback((roomCode: string) => {
    if (!db) throw new Error("Database not initialized");
    return ref(db!, `rooms/${roomCode.toUpperCase()}/messages`);
  }, [db]);

  const getMembersRef = React.useCallback((roomCode: string) => {
     if (!db) throw new Error("Database not initialized");
    return ref(db!, `rooms/${roomCode.toUpperCase()}/members`);
  }, [db]);

  const getUserRef = React.useCallback((roomCode: string, userId: string) => {
     if (!db) throw new Error("Database not initialized");
    return ref(db!, `rooms/${roomCode.toUpperCase()}/members/${userId}`);
  }, [db]);


  // Cleanup listeners
  const cleanupListeners = React.useCallback(() => {
    if (listenersRef.current.messages) {
      off(listenersRef.current.messages);
      listenersRef.current.messages = undefined;
      console.log("Messages listener detached.");
    }
    if (listenersRef.current.members) {
      off(listenersRef.current.members);
      listenersRef.current.members = undefined;
       console.log("Members listener detached.");
    }
     // Reset local state associated with listeners
    setMessages([]);
    setMembers([]);
    setError(null); // Clear errors related to the old room
    // Don't reset currentUser or currentRoomCode here, leaveRoom/joinRoom manage those
    console.log("Listeners cleaned up and related state reset.");
  }, []);


  // --- Core API Functions ---

   const checkRoomExists = React.useCallback(async (roomCode: string): Promise<boolean> => {
    if (!db) return false;
    try {
        const roomRef = getRoomRef(roomCode.toUpperCase()); // Ensure consistency
        const snapshot = await get(roomRef);
        return snapshot.exists();
    } catch (err: any) {
        console.error("Error checking room existence:", err);
        setError(`Failed to check room ${roomCode}: ${err.message}`);
        return false;
    }
  }, [db, getRoomRef, setError]);


  const roomExists = React.useCallback(async (roomCode: string): Promise<boolean> => {
    return checkRoomExists(roomCode); // Use the more specific check function
  }, [checkRoomExists]);


  const createRoom = React.useCallback(async (roomCode: string): Promise<void> => {
    if (!db) throw new Error("Database not initialized");
    setLoading(true);
    setError(null);
    try {
      const upperCaseRoomCode = roomCode.toUpperCase(); // Ensure consistency
      const roomRef = getRoomRef(upperCaseRoomCode);
       const roomSnapshot = await get(roomRef);
       if (roomSnapshot.exists()) {
         throw new Error(`Room ${upperCaseRoomCode} already exists.`);
       }
      await set(roomRef, {
        createdAt: serverTimestamp(),
        messages: {}, // Initialize messages node
        members: {}, // Initialize members node
      });
      console.log(`Room ${upperCaseRoomCode} created successfully.`);
    } catch (err: any) {
      console.error("Error creating room:", err);
      setError(`Failed to create room ${roomCode}: ${err.message}`);
      throw err; // Re-throw for the component to handle
    } finally {
      setLoading(false);
    }
  }, [db, getRoomRef, setError]);


  // Define leaveRoom *before* joinRoom because joinRoom depends on it for cleanup
  const leaveRoom = React.useCallback(async (roomCode: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
    const localCurrentUser = currentUser; // Capture current user at the start

     // Prevent leaving if not in the specified room or no user/db
    if (!db || !localCurrentUser || currentRoomCode.current !== roomCode) {
      console.warn(`Leave room (${roomCode}) called unnecessarily or without context. Current room: ${currentRoomCode.current}, User: ${localCurrentUser?.id}`);
      // Ensure state is clean if called in an inconsistent state
      if (currentRoomCode.current === roomCode || listenersRef.current.messages || listenersRef.current.members) {
           cleanupListeners();
      }
      setCurrentUser(null);
      currentRoomCode.current = null;
      setError(null); // Clear any previous error
      setLoading(false); // Ensure loading is false
      return;
    }

    console.log(`Attempting to leave room ${roomCode} as user ${localCurrentUser.id}...`);
    const userId = localCurrentUser.id;
    const userRef = getUserRef(roomCode, userId);

    // Reset state locally *before* async operations for faster UI feedback
    cleanupListeners();
    setCurrentUser(null); // Clear local user state immediately
    currentRoomCode.current = null; // Clear room tracking immediately
    setLoading(false); // Ensure loading is false after local state clear

    try {
        // 1. Cancel onDisconnect (best effort)
        try {
            await onDisconnect(userRef).cancel();
            console.log(`onDisconnect cancelled for ${userId}.`);
        } catch (cancelError: any) {
            console.warn(`Could not cancel onDisconnect (might already be disconnected): ${cancelError.message}`);
        }

        // 2. Mark user offline OR remove them
        try {
            // Using update ensures lastSeen is set even if user was already offline somehow
            await update(userRef, { online: false, lastSeen: serverTimestamp() });
            console.log(`User ${userId} marked as offline in DB.`);
        } catch (updateError: any) {
             console.warn(`Could not mark user ${userId} offline in DB: ${updateError.message}`);
        }

    } catch (err: any) {
      console.error("Unexpected error during leaveRoom DB operations:", err);
      // Local state is already cleared, just log the error
    } finally {
       setLoading(false);
       console.log(`Finished leaveRoom process for ${userId} in room ${roomCode}.`);
    }
  }, [db, currentUser, cleanupListeners, getUserRef, setError]); // Dependencies: db, currentUser, cleanupListeners, getUserRef, setError


   const joinRoom = React.useCallback(async (roomCode: string): Promise<boolean> => {
     if (!db) {
       setError("Database not initialized");
       return false;
     }
     roomCode = roomCode.toUpperCase(); // Ensure consistency

      if (loading && currentRoomCode.current === roomCode) {
          console.log("Join attempt ignored: Already joining room", roomCode);
          return false;
      }

     if (currentUser && currentRoomCode.current === roomCode) {
       console.log("Already in room:", roomCode);
       setLoading(false);
       setError(null);
       return true;
     }

     setLoading(true);
     setError(null);
     const attemptId = ++joinAttemptRef.current;
     console.log(`[Join Attempt ${attemptId}] Starting for room: ${roomCode}`);

     if (currentRoomCode.current && currentRoomCode.current !== roomCode) {
       console.log(`[Join Attempt ${attemptId}] Cleaning up listeners & state from previous room: ${currentRoomCode.current}`);
       await leaveRoom(currentRoomCode.current); // Await cleanup of the old room
     } else if (!currentRoomCode.current) {
        cleanupListeners();
     }
     currentRoomCode.current = roomCode;

     try {
       const roomRef = getRoomRef(roomCode);
       const membersRef = getMembersRef(roomCode);
       const memberId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
       const userName = generateRandomName();
       const userRef = getUserRef(roomCode, memberId);

        const roomSnapshot = await get(roomRef);
        if (!roomSnapshot.exists()) {
            if (joinAttemptRef.current !== attemptId) { console.log(`[Join Attempt ${attemptId}] Aborted: Newer attempt started.`); return false; }
            setError(`Room ${roomCode} does not exist.`);
            console.warn(`[Join Attempt ${attemptId}] Failed: Room ${roomCode} does not exist.`);
            currentRoomCode.current = null;
            setLoading(false);
            return false;
        }

       let transactionError: string | null = null;
       console.log(`[Join Attempt ${attemptId}] Starting transaction for new user ${memberId} (${userName})...`);
       const transactionResult = await runTransaction(membersRef, (currentMembers) => {
          if (joinAttemptRef.current !== attemptId) {
              console.log(`[Join Attempt ${attemptId} - TXN] Aborting: Newer attempt running.`);
              transactionError = "Aborted due to newer join attempt.";
              return undefined;
          }
          if (!currentMembers) currentMembers = {};

         const onlineMembers = Object.values(currentMembers).filter((m: any) => m?.online === true);
         const onlineMemberCount = onlineMembers.length;

         console.log(`[Join Attempt ${attemptId} - TXN] Current online members: ${onlineMemberCount}, Max allowed: ${MAX_MEMBERS}`);

         if (onlineMemberCount >= MAX_MEMBERS) {
           console.warn(`[Join Attempt ${attemptId} - TXN] Aborting: Room full (${onlineMemberCount}/${MAX_MEMBERS}).`);
           transactionError = `Room ${roomCode} is full. Max ${MAX_MEMBERS} members allowed.`; // More specific error
           return undefined;
         }

         const newUser: Member = { id: memberId, name: userName, online: true, lastSeen: serverTimestamp() };
         currentMembers[memberId] = newUser; // Directly modify draft state
         console.log(`[Join Attempt ${attemptId} - TXN] Proceeding to add new user ${memberId}.`);
         return currentMembers;
       }, { applyLocally: false });


        if (joinAttemptRef.current !== attemptId) {
            console.log(`[Join Attempt ${attemptId}] Aborted after transaction: Newer attempt started.`);
            if (transactionResult.committed) {
                console.warn(`[Join Attempt ${attemptId}] Transaction committed but attempt is outdated. Attempting cleanup.`);
                try { await remove(userRef); } catch (cleanupError) { console.error("Error cleaning up outdated user entry:", cleanupError); }
            }
            return false;
        }


       if (!transactionResult.committed) {
         const reason = transactionError || `Failed to add user due to high contention (maxretry).`;
         console.error(`[Join Attempt ${attemptId}] Transaction failed to commit for room ${roomCode}. Reason: ${reason}`);
         setError(reason); // Use the specific error message
         currentRoomCode.current = null;
         setLoading(false);
         return false;
       }

        console.log(`[Join Attempt ${attemptId}] Transaction committed successfully. User ${memberId} added.`);

       if (!transactionResult.snapshot.child(memberId).exists()) {
          console.error(`[Join Attempt ${attemptId}] CRITICAL: Transaction committed, but user ${memberId} missing in final snapshot.`);
          setError(`An inconsistency occurred while joining room ${roomCode}. Please try again.`);
          try { await remove(userRef); } catch (cleanupError) { console.error("Error cleaning up user entry after inconsistent transaction:", cleanupError); }
          currentRoomCode.current = null;
          setLoading(false);
          return false;
        }

        const finalUser = transactionResult.snapshot.child(memberId).val();
        setCurrentUser(finalUser);


        console.log(`[Join Attempt ${attemptId}] Setting up onDisconnect for ${memberId}...`);
        await onDisconnect(userRef).update({ online: false, lastSeen: serverTimestamp() });


        console.log(`[Join Attempt ${attemptId}] Attaching listeners...`);
        const messagesListenerRef = getMessagesRef(roomCode);
        listenersRef.current.messages = messagesListenerRef;
        onValue(messagesListenerRef, (snapshot) => {
            if (currentRoomCode.current !== roomCode || joinAttemptRef.current !== attemptId) return;
            const messagesData = snapshot.val();
            const loadedMessages: Message[] = messagesData ? Object.entries(messagesData).map(([id, msg]: [string, any]) => ({ id, ...msg })) : [];
            loadedMessages.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
            setMessages(loadedMessages);
        }, (err) => {
            if (currentRoomCode.current !== roomCode || joinAttemptRef.current !== attemptId) return;
            console.error(`Messages listener error for room ${roomCode}:`, err);
            setError(`Failed to load messages: ${err.message}`);
            cleanupListeners();
            setCurrentUser(null);
            currentRoomCode.current = null;
            setLoading(false);
        });

        const membersListenerRef = getMembersRef(roomCode);
        listenersRef.current.members = membersListenerRef;
        onValue(membersListenerRef, (snapshot) => {
            if (currentRoomCode.current !== roomCode || joinAttemptRef.current !== attemptId) return;
            const membersData = snapshot.val();
            const loadedMembers: Member[] = membersData ? Object.values(membersData).filter((m): m is Member => !!m) : [];
            setMembers(loadedMembers);

            const currentLocalUser = currentUser; // Capture current state for check
             if (currentLocalUser && currentRoomCode.current === roomCode) { // Check if we still think we're in this room
                const stillExists = loadedMembers.some(m => m.id === currentLocalUser.id);
                if (!stillExists) {
                    console.warn(`Current user ${currentLocalUser.id} no longer found in members list for room ${roomCode}. Forcing local leave.`);
                    setError("You seem to have been disconnected from the room.");
                    // Re-trigger leaveRoom which handles cleanup and state reset
                    leaveRoom(roomCode);
                }
            }

        }, (err) => {
            if (currentRoomCode.current !== roomCode || joinAttemptRef.current !== attemptId) return;
            console.error(`Members listener error for room ${roomCode}:`, err);
            setError(`Failed to load members: ${err.message}`);
            cleanupListeners();
            setCurrentUser(null);
            currentRoomCode.current = null;
            setLoading(false);
        });


       console.log(`[Join Attempt ${attemptId}] Successfully joined room ${roomCode} as ${finalUser.name} (${memberId})`);
       setLoading(false);
       return true;

     } catch (err: any) {
        if (joinAttemptRef.current !== attemptId) {
             console.log(`[Join Attempt ${attemptId}] Aborted due to error, but newer attempt started:`, err.message);
             return false;
        }

       console.error(`[Join Attempt ${attemptId}] General error during joinRoom process:`, err);
       const specificError = `Failed to join room ${roomCode}: ${err.message || 'Unknown error'}`;
       setError(specificError);
       cleanupListeners();
       setCurrentUser(null);
       currentRoomCode.current = null;
       setLoading(false);
       return false;
     }
   }, [
        db,
        currentUser,
        loading,
        error, // Include error to potentially react to previous errors
        cleanupListeners,
        getRoomRef,
        getMembersRef,
        getUserRef,
        getMessagesRef,
        toast,
        setError,
        leaveRoom // Include leaveRoom in dependencies as it's called within joinRoom
    ]);


  const sendMessage = React.useCallback(async (roomCode: string, text: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
     const localCurrentUser = currentUser; // Capture current user

    if (!db || !localCurrentUser || currentRoomCode.current !== roomCode) {
        console.error("Cannot send message: Conditions not met.", { db: !!db, user: !!localCurrentUser, currentRoom: currentRoomCode.current, targetRoom: roomCode });
        throw new Error("Cannot send message: Not connected to the room or database.");
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
       console.log("Attempted to send an empty message.");
       return;
    }

    const messagesRef = getMessagesRef(roomCode);
    const userRef = getUserRef(roomCode, localCurrentUser.id);

    const newMessage: Message = {
      senderId: localCurrentUser.id,
      text: trimmedText,
      timestamp: serverTimestamp(),
    };

    try {
      const newMessageRef = push(messagesRef);
      await set(newMessageRef, newMessage);
       try {
           await update(userRef, { lastSeen: serverTimestamp() });
       } catch (updateError) {
           console.warn(`Failed to update lastSeen for ${localCurrentUser.id} after sending message:`, updateError);
       }
    } catch (err: any) {
      console.error("Error sending message:", err);
      setError(`Failed to send message: ${err.message}`);
      throw err;
    }
  }, [db, currentUser, getMessagesRef, getUserRef, setError]);


  // --- Effects ---

  // Effect to cleanup listeners and leave room on component unmount
  React.useEffect(() => {
    const roomToLeave = currentRoomCode.current;
    const userToLeave = currentUser;

    return () => {
       console.log("ChatProvider unmounting...");
       if (userToLeave && roomToLeave) {
         console.log(`Initiating leaveRoom cleanup for user ${userToLeave.id} in room ${roomToLeave}`);
         leaveRoom(roomToLeave);
       } else {
          console.log("No active user/room, running listener cleanup only.");
          cleanupListeners();
       }
    };
  }, [currentUser, leaveRoom, cleanupListeners]); // Ensure leaveRoom and cleanupListeners are stable or included


   // Inactivity check
   React.useEffect(() => {
    const interval = setInterval(async () => {
       const currentCheckedRoom = currentRoomCode.current;
       const currentLocalUser = currentUser;

      if (!db || !currentCheckedRoom) return;

      const membersRef = getMembersRef(currentCheckedRoom);

      try {
        const snapshot = await get(membersRef);
        if (currentRoomCode.current !== currentCheckedRoom) return; // Abort if room changed during fetch

        if (!snapshot.exists()) {
           if (currentLocalUser && currentRoomCode.current === currentCheckedRoom) {
              console.warn(`Inactivity check found current room ${currentCheckedRoom} deleted. Forcing local leave.`);
              setError("The room seems to have been deleted.");
              leaveRoom(currentCheckedRoom); // Trigger full leave process
           }
           return;
        }

        const membersData = snapshot.val();
        const now = Date.now();
        const membersToRemove: string[] = [];

        for (const memberId in membersData) {
          const member = membersData[memberId] as Member;
          if (!member || !member.lastSeen) {
            console.warn(`Skipping member ${memberId} in inactivity check due to missing data.`);
            continue;
          }
          if (typeof member.lastSeen === 'number') {
            const timeSinceSeen = now - member.lastSeen;
             const isStaleOffline = !member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT;
             const isStaleOnline = member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT * 1.5;

            if (isStaleOffline || isStaleOnline) {
                const reason = isStaleOffline ? "inactive (offline)" : "inactive (stuck online)";
                console.log(`Scheduling removal of ${reason} member ${member.name} (${memberId}). Last seen: ${new Date(member.lastSeen).toISOString()}`);
                membersToRemove.push(memberId);
            }
          } else if (typeof member.lastSeen !== 'object') { // Ignore server timestamps (objects)
             console.warn(`Member ${member.name} (${memberId}) has invalid 'lastSeen' format:`, member.lastSeen);
          }
        }

        if (membersToRemove.length > 0) {
            const updates: { [key: string]: null } = {};
             membersToRemove.forEach(id => { updates[id] = null; });
            await update(membersRef, updates);
            console.log(`Removed ${membersToRemove.length} inactive members from room ${currentCheckedRoom}.`);

            // Optional: Check if local user was removed during this cleanup
             if (currentLocalUser && membersToRemove.includes(currentLocalUser.id) && currentRoomCode.current === currentCheckedRoom) {
                 console.warn(`Local user ${currentLocalUser.id} removed due to inactivity in room ${currentCheckedRoom}. Forcing local leave.`);
                 setError("You were removed from the room due to inactivity.");
                 // LeaveRoom might have already been called implicitly, but calling again ensures state consistency
                 leaveRoom(currentCheckedRoom);
             }
         }

      } catch (err: any) {
        console.error(`Error during inactivity check for room ${currentCheckedRoom}:`, err.message || err);
      }
    }, MEMBER_INACTIVITY_TIMEOUT / 2);

    return () => clearInterval(interval);
   }, [db, currentUser, getMembersRef, leaveRoom, setError]); // Added leaveRoom and setError


  // --- Value ---

  const value = React.useMemo(() => ({
    messages,
    members,
    currentUser,
    loading,
    error,
    roomExists,
    createRoom,
    joinRoom,
    leaveRoom,
    sendMessage,
    checkRoomExists,
  }), [messages, members, currentUser, loading, error, roomExists, createRoom, joinRoom, leaveRoom, sendMessage, checkRoomExists]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
