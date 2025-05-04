
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

const MAX_MEMBERS = 8; // Value is already 8
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
     // Reset local state
    setMessages([]);
    setMembers([]);
    // Don't reset currentUser immediately here, leaveRoom might need it briefly
    setError(null);
    currentRoomCode.current = null; // Clear the current room tracking
    console.log("Listeners cleaned up and state reset.");
  }, []);


  // --- Core API Functions ---

   const checkRoomExists = React.useCallback(async (roomCode: string): Promise<boolean> => {
    if (!db) return false;
    // setLoading(true); // Don't set loading for a simple check
    try {
        const roomRef = getRoomRef(roomCode);
        const snapshot = await get(roomRef);
        return snapshot.exists();
    } catch (err: any) {
        console.error("Error checking room existence:", err);
        setError(`Failed to check room ${roomCode}: ${err.message}`);
        return false;
    }
    // finally {
    //   setLoading(false); // Ensure loading is set to false
    // }
  }, [db, getRoomRef, setError]); // Added setError


  const roomExists = React.useCallback(async (roomCode: string): Promise<boolean> => {
    return checkRoomExists(roomCode); // Use the more specific check function
  }, [checkRoomExists]);


  const createRoom = React.useCallback(async (roomCode: string): Promise<void> => {
    if (!db) throw new Error("Database not initialized");
    setLoading(true);
    setError(null);
    try {
      const roomRef = getRoomRef(roomCode);
       const roomSnapshot = await get(roomRef);
       if (roomSnapshot.exists()) {
         throw new Error(`Room ${roomCode} already exists.`);
       }
      await set(roomRef, {
        createdAt: serverTimestamp(),
        messages: {}, // Initialize messages node
        members: {}, // Initialize members node
      });
      console.log(`Room ${roomCode} created successfully.`);
       // No need to join here, joinRoom will handle it
    } catch (err: any) {
      console.error("Error creating room:", err);
      setError(`Failed to create room ${roomCode}: ${err.message}`);
      throw err; // Re-throw for the component to handle
    } finally {
      setLoading(false);
    }
  }, [db, getRoomRef, setError]); // Added setError


   const joinRoom = React.useCallback(async (roomCode: string): Promise<boolean> => {
     if (!db) {
       setError("Database not initialized");
       return false;
     }
     roomCode = roomCode.toUpperCase(); // Ensure consistency

      // Prevent race condition: If already joining this room, wait or exit
      if (loading && currentRoomCode.current === roomCode) {
          console.log("Join attempt ignored: Already joining room", roomCode);
          return false; // Indicate join is already in progress
      }

     // If already in the room, return true immediately
     if (currentUser && currentRoomCode.current === roomCode) {
       console.log("Already in room:", roomCode);
       setLoading(false); // Already joined
       return true;
     }


     // --- Start Join Process ---
     setLoading(true);
     setError(null);
     const attemptId = ++joinAttemptRef.current; // Unique ID for this join attempt
     console.log(`[Join Attempt ${attemptId}] Starting for room: ${roomCode}`);


     // Clean up previous listeners ONLY if joining a DIFFERENT room or if no room was set
     if (currentRoomCode.current !== roomCode) {
       console.log(`[Join Attempt ${attemptId}] Cleaning up listeners from previous room: ${currentRoomCode.current}`);
       cleanupListeners();
     }
     currentRoomCode.current = roomCode; // Set the target room


     try {
       const roomRef = getRoomRef(roomCode);
       const membersRef = getMembersRef(roomCode);
       const memberId = currentUser?.id || `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
       const userName = currentUser?.name || generateRandomName();
       const userRef = getUserRef(roomCode, memberId);

        // Check if room exists before transaction
        const roomSnapshot = await get(roomRef);
        if (!roomSnapshot.exists()) {
            if (joinAttemptRef.current !== attemptId) { console.log(`[Join Attempt ${attemptId}] Aborted: Newer attempt started.`); return false; }
            setError(`Room ${roomCode} does not exist.`);
            console.warn(`[Join Attempt ${attemptId}] Failed: Room ${roomCode} does not exist.`);
            currentRoomCode.current = null; // Reset room code ref
            setLoading(false);
            return false;
        }

       // --- Transaction to Add User ---
       console.log(`[Join Attempt ${attemptId}] Starting transaction for user ${memberId}...`);
       const transactionResult = await runTransaction(membersRef, (currentMembers) => {
         if (currentMembers === null) {
           currentMembers = {};
         }

         const onlineMembers = Object.values(currentMembers).filter((m: any) => m?.online);
         const onlineMemberCount = onlineMembers.length;
         const isAlreadyOnline = onlineMembers.some((m: any) => m.id === memberId);

         console.log(`[Join Attempt ${attemptId} - TXN] Online: ${onlineMemberCount}, Max: ${MAX_MEMBERS}, User already online: ${isAlreadyOnline}`);

         if (onlineMemberCount >= MAX_MEMBERS && !isAlreadyOnline) {
           console.warn(`[Join Attempt ${attemptId} - TXN] Aborting: Room full.`);
           return undefined; // Abort transaction
         }

         // Prepare update
         const newUser: Member = { id: memberId, name: userName, online: true, lastSeen: serverTimestamp() };
         const updatedMembers = { ...currentMembers };
         updatedMembers[memberId] = newUser;
         console.log(`[Join Attempt ${attemptId} - TXN] Proceeding to update user ${memberId}.`);
         return updatedMembers; // Commit transaction attempt
       }, { applyLocally: false }); // applyLocally: false might help reduce race conditions


        // Check if aborted by newer attempt
        if (joinAttemptRef.current !== attemptId) {
            console.log(`[Join Attempt ${attemptId}] Aborted after transaction: Newer attempt started.`);
            // If transaction committed but attempt is old, we might need to leave?
            // This is complex. For now, just log and return false.
            // If the transaction failed, no harm done.
            if (transactionResult.committed) {
                console.warn(`[Join Attempt ${attemptId}] Transaction committed but attempt is outdated. User ${memberId} might be left in room ${roomCode}. Manual cleanup might be needed if issues persist.`);
                // Ideally, trigger a leave for memberId in roomCode here, but that adds complexity.
            }
            return false;
        }


       // --- Process Transaction Result ---
       if (!transactionResult.committed) {
         console.error(`[Join Attempt ${attemptId}] Transaction failed to commit for room ${roomCode}. Likely reason: Room full or high contention.`);
         setError(`Failed to join room ${roomCode}. The room might be full or experiencing high traffic. Please try again.`);
         currentRoomCode.current = null; // Reset room code ref
         setLoading(false);
         return false;
       }

        // Verify user exists in snapshot post-commit
       if (!transactionResult.snapshot.child(memberId).exists()) {
          console.error(`[Join Attempt ${attemptId}] Transaction committed, but user ${memberId} missing in final snapshot.`);
          setError(`An inconsistency occurred while joining room ${roomCode}. Please try again.`);
          // Attempt cleanup
          try { await remove(userRef); } catch (cleanupError) { console.error("Error cleaning up user entry after inconsistent transaction:", cleanupError); }
          currentRoomCode.current = null;
          setLoading(false);
          return false;
        }


        // --- Successfully Joined ---
        const finalUser = transactionResult.snapshot.child(memberId).val();
        setCurrentUser(finalUser); // Set current user state


       // --- Setup Listeners and onDisconnect ---
        console.log(`[Join Attempt ${attemptId}] Setting up onDisconnect for ${memberId}...`);
        await onDisconnect(userRef).update({ online: false, lastSeen: serverTimestamp() });


        console.log(`[Join Attempt ${attemptId}] Attaching listeners...`);
        // Messages Listener
        const messagesListenerRef = getMessagesRef(roomCode);
        listenersRef.current.messages = messagesListenerRef;
        onValue(messagesListenerRef, (snapshot) => {
            // Check if this listener belongs to the *current* active attempt/room
            if (currentRoomCode.current !== roomCode) return;
            const messagesData = snapshot.val();
            const loadedMessages: Message[] = messagesData ? Object.entries(messagesData).map(([id, msg]: [string, any]) => ({ id, ...msg })) : [];
            if (loadedMessages.length > 0) {
                loadedMessages.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
            }
            setMessages(loadedMessages);
            // console.log(`Messages updated for room ${roomCode}:`, loadedMessages.length); // Less verbose logging
        }, (err) => {
            if (currentRoomCode.current !== roomCode) return; // Ignore errors from old listeners
            console.error(`Messages listener error for room ${roomCode}:`, err);
            setError(`Failed to load messages: ${err.message}`);
            if (joinAttemptRef.current === attemptId) { // Only cleanup if it's the current attempt's error
                cleanupListeners();
                setCurrentUser(null);
                currentRoomCode.current = null;
                setLoading(false);
            }
        });

        // Members Listener
        const membersListenerRef = getMembersRef(roomCode);
        listenersRef.current.members = membersListenerRef;
        onValue(membersListenerRef, (snapshot) => {
            if (currentRoomCode.current !== roomCode) return; // Check if listener belongs to the current room
            const membersData = snapshot.val();
            const loadedMembers: Member[] = membersData ? Object.values(membersData).filter((m): m is Member => !!m) : [];
            setMembers(loadedMembers);
            // console.log(`Members updated for room ${roomCode}:`, loadedMembers.length); // Less verbose logging

            // Check if *current user* (based on local state) was removed
            // Ensure currentUser hasn't changed due to another process/attempt
            const currentLocalUser = currentUser; // Capture current state
             if (currentLocalUser && currentRoomCode.current === roomCode) {
                const stillExists = loadedMembers.some(m => m.id === currentLocalUser.id);
                if (!stillExists) {
                    console.warn(`Current user ${currentLocalUser.id} no longer found in members list for room ${roomCode}. Forcing local leave.`);
                    setError("You seem to have been disconnected from the room.");
                     if (joinAttemptRef.current === attemptId) { // Check if this is the current active attempt
                        cleanupListeners();
                        setCurrentUser(null);
                        currentRoomCode.current = null;
                        setLoading(false);
                    }
                }
            }

        }, (err) => {
            if (currentRoomCode.current !== roomCode) return; // Ignore errors from old listeners
            console.error(`Members listener error for room ${roomCode}:`, err);
            setError(`Failed to load members: ${err.message}`);
            if (joinAttemptRef.current === attemptId) { // Only cleanup if it's the current attempt's error
                cleanupListeners();
                setCurrentUser(null);
                currentRoomCode.current = null;
                setLoading(false);
            }
        });


       console.log(`[Join Attempt ${attemptId}] Successfully joined room ${roomCode} as ${finalUser.name} (${memberId})`);
       setLoading(false);
       return true;

     } catch (err: any) {
        if (joinAttemptRef.current !== attemptId) {
             console.log(`[Join Attempt ${attemptId}] Aborted due to error, but newer attempt started:`, err.message);
             return false; // Don't update state for old attempt errors
        }

       console.error(`[Join Attempt ${attemptId}] General error during joinRoom process:`, err);
       let specificError = `Failed to join room ${roomCode}: ${err.message || 'Unknown error'}`;
        // Improved error handling for maxretry
        if (err.code === 'maxretry' || (err.message && err.message.toLowerCase().includes('maxretry'))) {
            specificError = `Failed to join room ${roomCode}. The room might be full or busy. Please try again shortly.`;
            console.error("[Join Attempt ${attemptId}] Join room failed specifically due to maxretry.");
        }
       setError(specificError);
       cleanupListeners(); // Ensure cleanup on any error
       setCurrentUser(null); // Clear current user on join failure
       currentRoomCode.current = null; // Reset room code ref
       setLoading(false);
       return false;
     }
   }, [db, currentUser, loading, cleanupListeners, getRoomRef, getMembersRef, getUserRef, getMessagesRef, toast, setError]); // Added loading, setError


   const leaveRoom = React.useCallback(async (roomCode: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
    const localCurrentUser = currentUser; // Capture current user at the start

     // Prevent leaving if not in the specified room or no user/db
    if (!db || !localCurrentUser || currentRoomCode.current !== roomCode) {
      console.warn(`Leave room (${roomCode}) called unnecessarily or without context. Current room: ${currentRoomCode.current}, User: ${localCurrentUser?.id}`);
      // Attempt cleanup anyway, but don't change loading state if nothing to do
       if (currentRoomCode.current || listenersRef.current.messages || listenersRef.current.members) {
           cleanupListeners();
       }
      // Reset state if this leave call is intended to clear things, even if context was wrong
      setCurrentUser(null);
      currentRoomCode.current = null;
      setError(null); // Clear any previous error
      setLoading(false); // Ensure loading is false
      return;
    }

     // Indicate leaving process
    // setLoading(true); // Temporarily disable setting loading true on leave to avoid flicker
    console.log(`Attempting to leave room ${roomCode} as user ${localCurrentUser.id}...`);
    const userId = localCurrentUser.id;
    const userRef = getUserRef(roomCode, userId);
    const membersRef = getMembersRef(roomCode); // Ref for checking remaining members

    // --- Perform Leave Operations ---
    try {
        // 1. Cancel onDisconnect (best effort)
        try {
            await onDisconnect(userRef).cancel();
            console.log(`onDisconnect cancelled for ${userId}.`);
        } catch (cancelError: any) {
            console.warn(`Could not cancel onDisconnect: ${cancelError.message}`);
        }

        // 2. Mark user offline (or remove)
        try {
            await update(userRef, { online: false, lastSeen: serverTimestamp() });
            console.log(`User ${userId} marked as offline.`);
            // Or: await remove(userRef); console.log(`User ${userId} removed.`);
        } catch (updateError: any) {
            console.warn(`Could not mark user ${userId} offline: ${updateError.message}`);
        }

        // 3. Check if room is now empty (optional)
        try {
            const membersSnapshot = await get(membersRef);
            if (membersSnapshot.exists()) {
                const membersData = membersSnapshot.val();
                const remainingOnline = Object.values(membersData || {}).filter((m: any) => m?.online);
                if (remainingOnline.length === 0) {
                    console.log(`Last online user (${userId}) left room ${roomCode}. Consider deleting room.`);
                    // await remove(getRoomRef(roomCode)); // Uncomment to delete
                } else {
                    console.log(`${remainingOnline.length} online members remain.`);
                }
            } else {
                 console.log(`Members node for ${roomCode} missing after leave.`);
            }
        } catch (readError: any) {
            console.error(`Error reading members after leave: ${readError.message}`);
        }

    } catch (err: any) {
      // Catch unexpected errors during the leave process itself
      console.error("Unexpected error during leaveRoom process:", err);
      setError(`An error occurred while leaving: ${err.message}`);
    } finally {
       // --- Final Cleanup ---
       // Important: Perform cleanup *after* DB operations attempt
       cleanupListeners();
       setCurrentUser(null); // Clear local user state
       currentRoomCode.current = null; // Clear room tracking
       setLoading(false); // Ensure loading is false
       console.log(`Finished leaveRoom process for ${userId} in room ${roomCode}.`);
    }
  }, [db, currentUser, cleanupListeners, getUserRef, getMembersRef, getRoomRef, setError]); // Added getRoomRef, setError


  const sendMessage = React.useCallback(async (roomCode: string, text: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
     const localCurrentUser = currentUser; // Capture current user

    // Check conditions at the beginning
    if (!db || !localCurrentUser || currentRoomCode.current !== roomCode) {
        console.error("Cannot send message: Conditions not met.", { db: !!db, user: !!localCurrentUser, currentRoom: currentRoomCode.current, targetRoom: roomCode });
        throw new Error("Cannot send message: Not connected to the room or database.");
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
       console.log("Attempted to send an empty message.");
       return; // Don't send empty messages
    }

    const messagesRef = getMessagesRef(roomCode);
    const userRef = getUserRef(roomCode, localCurrentUser.id); // Get user ref for update

    const newMessage: Message = {
      senderId: localCurrentUser.id,
      text: trimmedText,
      timestamp: serverTimestamp(),
    };

    try {
       // 1. Push the new message
      const newMessageRef = push(messagesRef); // Get ref for the new message key
      await set(newMessageRef, newMessage); // Set the message data

      // 2. Update user's lastSeen timestamp (best effort, can fail silently if needed)
       try {
           await update(userRef, { lastSeen: serverTimestamp() });
       } catch (updateError) {
           console.warn(`Failed to update lastSeen for ${localCurrentUser.id} after sending message:`, updateError);
       }

      // console.log(`Message sent by ${localCurrentUser.id} in room ${roomCode}.`); // Less verbose

    } catch (err: any) {
      console.error("Error sending message:", err);
      setError(`Failed to send message: ${err.message}`);
      throw err; // Re-throw for the component to potentially handle
    }
  }, [db, currentUser, getMessagesRef, getUserRef, setError]); // Added setError


  // --- Effects ---

  // Effect to cleanup listeners and leave room on component unmount
  React.useEffect(() => {
    // Store refs needed for cleanup function
    const roomToLeave = currentRoomCode.current;
    const userToLeave = currentUser;

    return () => {
       // This cleanup runs when the ChatProvider itself unmounts
       console.log("ChatProvider unmounting...");
       if (userToLeave && roomToLeave) {
         console.log(`Initiating leaveRoom cleanup for user ${userToLeave.id} in room ${roomToLeave}`);
         // Call leaveRoom directly - it handles its own state and cleanup
         // Note: leaveRoom is async but we can't await it in cleanup.
         // It needs to handle errors gracefully internally.
         leaveRoom(roomToLeave);
       } else {
          // Ensure listeners are cleaned even if no user/room was active
          console.log("No active user/room, running listener cleanup only.");
          cleanupListeners();
       }
    };
   // Dependency array should include variables used to decide *if* cleanup runs
   // and the cleanup functions themselves if they are not stable.
  }, [currentUser, leaveRoom, cleanupListeners]);


   // Inactivity check (optional but good practice for cleanup)
   React.useEffect(() => {
    const interval = setInterval(async () => {
      // Capture current state at interval start
       const currentCheckedRoom = currentRoomCode.current;
       const currentLocalUser = currentUser;

       // Only run if DB connected and in a room
      if (!db || !currentCheckedRoom) return;

      console.log(`Running inactivity check for room: ${currentCheckedRoom}`);
      const membersRef = getMembersRef(currentCheckedRoom);


      try {
        const snapshot = await get(membersRef);
        // If the room code changed while we were fetching, abort this check
        if (currentRoomCode.current !== currentCheckedRoom) {
          console.log("Inactivity check aborted: Room changed during fetch.");
          return;
        }

        if (!snapshot.exists()) {
           console.log(`Inactivity check: Room ${currentCheckedRoom} does not exist or is empty.`);
           // If the *local user* thought they were in this room, trigger leave state
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
          if (member && typeof member.lastSeen === 'number') {
            const timeSinceSeen = now - member.lastSeen;
             const isStaleOffline = !member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT;
             const isStaleOnline = member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT * 3; // Stuck online

            if (isStaleOffline || isStaleOnline) {
                const reason = isStaleOffline ? "inactive (offline)" : "inactive (stuck online)";
                console.log(`Scheduling removal of ${reason} member ${member.name} (${memberId}). Last seen: ${new Date(member.lastSeen).toISOString()}`);
                membersToRemove.push(memberId);
            }
          } else if (member) {
             console.warn(`Member ${member.name} (${memberId}) has invalid 'lastSeen':`, member.lastSeen);
          }
        }

        // Batch remove members if any are identified
        if (membersToRemove.length > 0) {
            const updates: { [key: string]: null } = {};
             membersToRemove.forEach(id => { updates[id] = null; });
            await update(membersRef, updates);
            console.log(`Removed ${membersToRemove.length} inactive members from room ${currentCheckedRoom}.`);

            // Re-fetch to check if room is now empty
             const updatedSnapshot = await get(membersRef);
             if (currentRoomCode.current !== currentCheckedRoom) return; // Abort if room changed again

             const remainingMembers = updatedSnapshot.exists() ? Object.values(updatedSnapshot.val() || {}) : [];
             if (remainingMembers.length === 0) {
                console.log(`Room ${currentCheckedRoom} is empty after inactivity check. Optional: Delete room.`);
                 // await remove(getRoomRef(currentCheckedRoom)); // Uncomment to delete

                 // If the local user was in this now-empty room, clear their state
                 if (currentLocalUser && currentRoomCode.current === currentCheckedRoom) {
                     console.log(`Local user was in room ${currentCheckedRoom} which became empty. Forcing local leave.`);
                     setError("The room has become empty.");
                     leaveRoom(currentCheckedRoom); // Trigger leave process
                 }
             }
         }

      } catch (err: any) {
        // Avoid setting global error for background task failures
        console.error(`Error during inactivity check for room ${currentCheckedRoom}:`, err.message || err);
      }
    }, MEMBER_INACTIVITY_TIMEOUT); // Check more frequently, e.g., every minute

    return () => clearInterval(interval);
    // Depends on DB, user (to check if *they* need cleanup), and the leave/cleanup functions
   }, [db, currentUser, getMembersRef, getRoomRef, leaveRoom, setError]); // Added setError, getRoomRef, leaveRoom


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
    checkRoomExists, // Expose the specific check function
  }), [messages, members, currentUser, loading, error, roomExists, createRoom, joinRoom, leaveRoom, sendMessage, checkRoomExists]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

