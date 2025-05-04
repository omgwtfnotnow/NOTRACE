
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
  update, // Ensure update is imported
  off,
  get,
  DatabaseReference,
} from 'firebase/database';
import { useFirebase } from './firebase-context';
import { generateRandomName } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

const MAX_MEMBERS = 8;
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


  // --- Utility Functions ---

  const getRoomRef = React.useCallback((roomCode: string) => {
    if (!db) throw new Error("Database not initialized");
    return ref(db, `rooms/${roomCode.toUpperCase()}`);
  }, [db]);

  const getMessagesRef = React.useCallback((roomCode: string) => {
    return ref(db!, `rooms/${roomCode.toUpperCase()}/messages`);
  }, [db]);

  const getMembersRef = React.useCallback((roomCode: string) => {
    return ref(db!, `rooms/${roomCode.toUpperCase()}/members`);
  }, [db]);

  const getUserRef = React.useCallback((roomCode: string, userId: string) => {
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
    // Keep currentUser briefly for potential leave operations, but maybe reset here too?
    // setCurrentUser(null); // Consider implications
    setError(null);
    currentRoomCode.current = null;
    console.log("Listeners cleaned up and state reset.");
  }, []);


  // --- Core API Functions ---

   const checkRoomExists = React.useCallback(async (roomCode: string): Promise<boolean> => {
    if (!db) return false;
    setLoading(true);
    try {
        const roomRef = getRoomRef(roomCode);
        const snapshot = await get(roomRef);
        return snapshot.exists();
    } catch (err: any) {
        console.error("Error checking room existence:", err);
        setError(`Failed to check room ${roomCode}: ${err.message}`);
        return false;
    } finally {
      setLoading(false); // Ensure loading is set to false
    }
  }, [db, getRoomRef]);


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
  }, [db, getRoomRef]);


   const joinRoom = React.useCallback(async (roomCode: string): Promise<boolean> => {
     if (!db) {
       setError("Database not initialized");
       return false;
     }
     roomCode = roomCode.toUpperCase(); // Ensure consistency
     if (currentRoomCode.current === roomCode && currentUser) {
       console.log("Already in room:", roomCode);
       setLoading(false); // Already joined
       return true;
     }

     setLoading(true);
     setError(null);
     cleanupListeners(); // Clean up previous listeners before joining a new room
     currentRoomCode.current = roomCode; // Store current room

     try {
       const roomRef = getRoomRef(roomCode);
       const roomSnapshot = await get(roomRef);

       if (!roomSnapshot.exists()) {
         setError(`Room ${roomCode} does not exist.`);
         console.warn(`Attempted to join non-existent room: ${roomCode}`);
         currentRoomCode.current = null; // Reset room code ref
         setLoading(false);
         return false;
       }

       const membersRef = getMembersRef(roomCode);
       // Ensure memberId is generated consistently, even if currentUser briefly exists from a previous failed attempt
       const memberId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
       const userName = generateRandomName();
       const userRef = getUserRef(roomCode, memberId);

       const newUser: Member = { id: memberId, name: userName, online: true, lastSeen: serverTimestamp() };

       // Transaction to ensure atomicity and check member count
       const transactionResult = await runTransaction(membersRef, (currentMembers) => {
        // Attempt number is implicitly handled by Firebase retries, but we can log
        // Note: The actual retry count isn't directly available inside the function AFAIK.
        console.log(`Transaction update function running for user: ${memberId} in room: ${roomCode}`);

        // Initialize if null
        if (currentMembers === null) {
          console.log(`Transaction: Initializing members node.`);
          currentMembers = {};
        } else {
          // Log the state received by this attempt
          console.log(`Transaction: Received members state keys:`, JSON.stringify(Object.keys(currentMembers)));
        }

        // Check if the user trying to join is *already* in the list and marked online
        const isAlreadyOnline = currentMembers[memberId]?.online === true;

        // Count currently online members *excluding* the joining user if they were previously offline or not present
        const onlineMembers = Object.values(currentMembers || {}).filter((m: any) => m?.online === true && m.id !== memberId);
        const onlineMemberCount = onlineMembers.length;
        const potentialCount = onlineMemberCount + 1; // Count if the current user joins/becomes online

        console.log(`Transaction: Current online count (excluding ${memberId}): ${onlineMemberCount}, Potential count: ${potentialCount}, Is already online: ${isAlreadyOnline}, Max Members: ${MAX_MEMBERS}`);
        // Log names of online members for debugging
        // Careful with logging potentially large amounts of data in production
        // console.log(`Transaction: Online members names: ${onlineMembers.map((m: any) => m.name).join(', ')}`);


        if (!isAlreadyOnline && potentialCount > MAX_MEMBERS) {
          // Room is full, and this user joining would exceed the limit
          console.warn(`Transaction Aborting (condition met): Room full. Potential count ${potentialCount} exceeds MAX_MEMBERS ${MAX_MEMBERS}.`);
          // Returning undefined signals the SDK to retry if the data has changed since the read.
          // If the data hasn't changed and this condition is met, it will eventually abort after max retries.
          return; // Abort *this attempt* if condition met based on current data
        }

        // Proceed to add/update the user
        console.log(`Transaction OK: Proceeding to update user ${memberId}`);
        // Create a *new* object for the update to avoid modifying the input `currentMembers` directly before returning.
        const updatedMembers = { ...currentMembers };
        updatedMembers[memberId] = newUser; // Add or update user (marks them online)
        return updatedMembers; // Commit transaction with the new state
       });


       if (!transactionResult.committed || !transactionResult.snapshot.exists()) {
           // The transaction was aborted (likely due to max retries or explicit abort) or failed for other reasons
           const reason = transactionResult.committed ? "failed (snapshot doesn't exist)" : "aborted (likely max retries or explicit abort)";
           setError(`Room ${roomCode} is full or join failed.`); // More generic error
           console.warn(`Join transaction ${reason} for room ${roomCode}. Committed: ${transactionResult.committed}`);
           currentRoomCode.current = null; // Reset room code ref
           setLoading(false);
           return false;
       }


       setCurrentUser(newUser); // Set the current user state *after* successful transaction

       // Setup onDisconnect handlers
       await onDisconnect(userRef).update({ online: false, lastSeen: serverTimestamp() });
       console.log(`onDisconnect set for ${memberId} in room ${roomCode}`);

       // Attach listeners
       const messagesListenerRef = getMessagesRef(roomCode);
       listenersRef.current.messages = messagesListenerRef; // Store ref for cleanup
       onValue(messagesListenerRef, (snapshot) => {
         const messagesData = snapshot.val();
         const loadedMessages: Message[] = messagesData
           ? Object.entries(messagesData).map(([id, msg]: [string, any]) => ({
               id,
               ...msg,
             }))
           : [];
         // Sort messages only if they are not empty to avoid errors
         if (loadedMessages.length > 0) {
            loadedMessages.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
         }
         setMessages(loadedMessages);
          console.log(`Messages updated for room ${roomCode}:`, loadedMessages.length, "messages");
       }, (err) => {
          console.error(`Messages listener error for room ${roomCode}:`, err);
          setError(`Failed to load messages: ${err.message}`);
          cleanupListeners(); // Detach on error
       });


       const membersListenerRef = getMembersRef(roomCode);
       listenersRef.current.members = membersListenerRef; // Store ref for cleanup
       onValue(membersListenerRef, (snapshot) => {
         const membersData = snapshot.val();
         const loadedMembers: Member[] = membersData
           ? Object.values(membersData)
           : [];
         setMembers(loadedMembers.filter(m => m)); // Filter out potentially null entries if deletion is inconsistent
         console.log(`Members updated for room ${roomCode}:`, loadedMembers.length, "members");

         // Check if current user was removed (e.g., kicked or data inconsistency)
         // Ensure currentUser is still defined before checking its id
         if (currentUser && (!membersData || !membersData[currentUser.id])) {
            console.warn(`Current user ${currentUser.id} not found in members list for room ${roomCode}. Leaving room.`);
            // Avoid calling leaveRoom directly here to prevent loops if the listener triggers again
            setError("You seem to have been removed from the room.");
            cleanupListeners();
            setCurrentUser(null); // Clear current user as they are no longer in the room
            currentRoomCode.current = null; // Reset room code ref
            setLoading(false);
         }

       }, (err) => {
          console.error(`Members listener error for room ${roomCode}:`, err);
          setError(`Failed to load members: ${err.message}`);
          cleanupListeners(); // Detach on error
       });

       console.log(`Successfully joined room ${roomCode} as ${userName} (${memberId})`);
       setLoading(false);
       return true;

     } catch (err: any) {
       console.error("Error joining room:", err);
        // Check for maxretry error specifically
       if (err.message && err.message.toLowerCase().includes('maxretry')) {
            setError(`Failed to join room ${roomCode} due to high contention. Please try again.`);
       } else {
           setError(`Failed to join room ${roomCode}: ${err.message}`);
       }
       cleanupListeners(); // Ensure cleanup on error
       setCurrentUser(null); // Clear current user on join failure
       currentRoomCode.current = null; // Reset room code ref
       setLoading(false);
       return false;
     }
   }, [db, currentUser, cleanupListeners, getRoomRef, getMembersRef, getUserRef, getMessagesRef, toast]); // Added dependencies


   const leaveRoom = React.useCallback(async (roomCode: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
    if (!db || !currentUser || currentRoomCode.current !== roomCode) {
      console.warn("Leave room called unnecessarily or without DB/user/correct room context.");
      cleanupListeners(); // Still try to clean up just in case
      setCurrentUser(null);
      currentRoomCode.current = null;
      return;
    }

    setLoading(true); // Indicate leaving process
    const userId = currentUser.id;
    const userRef = getUserRef(roomCode, userId);
    const membersRef = getMembersRef(roomCode); // Ref for checking remaining members


    console.log(`Attempting to leave room ${roomCode} as user ${userId}...`);

    try {
      // 1. Cancel the onDisconnect handler first
      await onDisconnect(userRef).cancel();
      console.log(`onDisconnect cancelled for ${userId} in room ${roomCode}.`);

      // 2. Mark the user as offline immediately using update
      await update(userRef, { online: false, lastSeen: serverTimestamp() });
      console.log(`User ${userId} marked as offline in room ${roomCode}.`);
      // Option B: Remove the user entirely (simpler state)
      // await remove(userRef);
      // console.log(`User ${userId} removed from room ${roomCode}.`);


       // 3. Check if the room should be deleted (optional, based on your logic)
      const membersSnapshot = await get(membersRef);
      const remainingMembers = membersSnapshot.val() ? Object.values(membersSnapshot.val()).filter((m: any) => m?.online) : [];

      if (remainingMembers.length === 0) {
          console.log(`Last user left room ${roomCode}. Deleting room.`);
          // await remove(getRoomRef(roomCode)); // Uncomment to delete room
      } else {
          console.log(`${remainingMembers.length} members remaining in room ${roomCode}.`);
      }


    } catch (err: any) {
      console.error("Error leaving room:", err);
      setError(`Failed to leave room ${roomCode}: ${err.message}`);
      // Don't re-throw here, just log the error. Cleanup will happen anyway.
    } finally {
       // 4. Clean up listeners and reset state regardless of success/failure
       cleanupListeners();
       setCurrentUser(null); // Clear current user state *after* DB operations
       currentRoomCode.current = null;
       setLoading(false); // Finish loading state
       console.log(`Finished leaveRoom process for ${userId} in room ${roomCode}.`);
    }
  }, [db, currentUser, cleanupListeners, getUserRef, getMembersRef, getRoomRef]); // Added getRoomRef


  const sendMessage = React.useCallback(async (roomCode: string, text: string): Promise<void> => {
    roomCode = roomCode.toUpperCase(); // Ensure consistency
    if (!db || !currentUser || currentRoomCode.current !== roomCode) {
      throw new Error("Cannot send message: Not connected to the room or database.");
    }
    const messagesRef = getMessagesRef(roomCode);
    const newMessage: Message = {
      senderId: currentUser.id,
      text: text.trim(),
      timestamp: serverTimestamp(),
    };
    try {
      await push(messagesRef, newMessage);
       // Update user's lastSeen timestamp on sending a message
      const userRef = getUserRef(roomCode, currentUser.id);
      await update(userRef, { lastSeen: serverTimestamp() });
    } catch (err: any) {
      console.error("Error sending message:", err);
      setError(`Failed to send message: ${err.message}`);
      throw err;
    }
  }, [db, currentUser, getMessagesRef, getUserRef]); // Added getUserRef


  // --- Effects ---

  // Effect to cleanup listeners on component unmount
  React.useEffect(() => {
    return () => {
       // This cleanup runs when the ChatProvider itself unmounts
       if (currentUser && currentRoomCode.current) {
         console.log("ChatProvider unmounting, ensuring user leaves room:", currentRoomCode.current);
         // Directly call the database operation part without full state updates if needed
         // Or rely on the beforeunload handler
         // leaveRoom(currentRoomCode.current); // Potential issue if component unmounts before DB ops complete
       }
      cleanupListeners();
    };
  }, [currentUser, cleanupListeners]); // Removed leaveRoom dependency


   // Inactivity check (optional but good practice for cleanup)
   React.useEffect(() => {
    const interval = setInterval(async () => {
      if (!db || !currentRoomCode.current) return;

      const currentCheckedRoom = currentRoomCode.current; // Capture the room code at the start of the interval
      const membersRef = getMembersRef(currentCheckedRoom);


      try {
        const snapshot = await get(membersRef);
        // If the room code changed while we were fetching, abort this check
        if (currentRoomCode.current !== currentCheckedRoom) {
          console.log("Inactivity check aborted: Room changed during fetch.");
          return;
        }

        const membersData = snapshot.val();
        if (!snapshot.exists() || !membersData) {
           // Room might have been deleted, or is empty
           console.log(`Inactivity check: Room ${currentCheckedRoom} does not exist or has no members.`);
           return;
        }

        const now = Date.now();
        let membersRemoved = false;

        for (const memberId in membersData) {
          const member = membersData[memberId] as Member;
          // Check only 'offline' members based on the onDisconnect mechanism (or very old lastSeen even if online flag is stuck)
          if (member && typeof member.lastSeen === 'number' && (now - member.lastSeen > MEMBER_INACTIVITY_TIMEOUT)) {
             if (!member.online) {
                console.log(`Removing inactive (offline) member ${member.name} (${memberId}) from room ${currentCheckedRoom}. Last seen: ${new Date(member.lastSeen).toISOString()}`);
                await remove(getUserRef(currentCheckedRoom, memberId));
                membersRemoved = true;
             } else {
                // Optional: Handle cases where 'online' might be stuck true but lastSeen is very old
                console.warn(`Member ${member.name} (${memberId}) in room ${currentCheckedRoom} is marked online but lastSeen (${new Date(member.lastSeen).toISOString()}) is older than timeout. Consider removing.`);
                 // await remove(getUserRef(currentCheckedRoom, memberId)); // Uncomment to remove potentially stuck users
                 // membersRemoved = true;
             }
          }
        }

         // If members were removed, re-check if the room is now empty
        if(membersRemoved) {
             const updatedSnapshot = await get(membersRef);
             // Abort if room changed again
             if (currentRoomCode.current !== currentCheckedRoom) return;

             const remainingMembers = updatedSnapshot.val() ? Object.values(updatedSnapshot.val()) : [];
             if (remainingMembers.length === 0) {
                console.log(`Room ${currentCheckedRoom} is empty after inactivity check. Deleting room.`);
                 // await remove(getRoomRef(currentCheckedRoom)); // Uncomment to delete room
                 // If room is deleted, we should also clean up local state if the current user was technically still "in" it
                 if (currentRoomCode.current === currentCheckedRoom) {
                     // cleanupListeners(); // Might already be handled if user was marked offline
                     // setCurrentUser(null);
                     // currentRoomCode.current = null;
                 }
             }
        }

      } catch (err) {
        // Avoid setting global error for background task failures
        console.error(`Error during inactivity check for room ${currentCheckedRoom}:`, err);
      }
    }, MEMBER_INACTIVITY_TIMEOUT / 2); // Check periodically

    return () => clearInterval(interval);
   }, [db, getMembersRef, getUserRef, getRoomRef]); // Added getRoomRef

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
