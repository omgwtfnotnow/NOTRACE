
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
         console.log(`Transaction update attempt for user: ${memberId} in room: ${roomCode}`);

         // Initialize if null
         if (currentMembers === null) {
           currentMembers = {};
         }

         // Count currently online members
         const onlineMembers = Object.values(currentMembers || {}).filter((m: any) => m?.online === true);
         const onlineMemberCount = onlineMembers.length;

         console.log(`Transaction Check: Current online members: ${onlineMemberCount}, Max Members: ${MAX_MEMBERS}`);

         // Check if room is full *before* attempting to add the new user
         if (onlineMemberCount >= MAX_MEMBERS) {
           // Explicitly check if the *joining user* is one of the online members (edge case: rejoining quickly)
           const alreadyIn = onlineMembers.some((m: any) => m.id === memberId);
           if (!alreadyIn) {
             console.warn(`Transaction Aborting: Room full. Online count ${onlineMemberCount} >= MAX_MEMBERS ${MAX_MEMBERS}.`);
             // Returning undefined tells Firebase the transaction didn't modify data,
             // allowing it to potentially retry if the data changed. If the room remains full,
             // it will eventually fail after max retries.
             return undefined; // Explicitly abort this attempt
           } else {
              console.log(`Transaction Note: User ${memberId} seems to be rejoining an already full room they were in. Allowing update.`);
           }
         }

         // Proceed to add/update the user
         console.log(`Transaction OK: Proceeding to add/update user ${memberId}`);
         // Important: Return a *new* object for the update, don't modify the input `currentMembers` directly.
         const updatedMembers = { ...currentMembers };
         updatedMembers[memberId] = newUser; // Add or update user (marks them online)
         return updatedMembers; // Commit transaction attempt with the new state
       });


       // Check the outcome of the transaction
       if (!transactionResult.committed) {
         // Transaction failed, likely due to hitting max retries because the room was full
         // or potentially other database contention issues.
         console.error(`Join transaction failed to commit for room ${roomCode}. Likely कारण: Room full or high contention.`);
         setError(`Failed to join room ${roomCode}. The room might be full or experiencing high traffic. Please try again.`);
         currentRoomCode.current = null; // Reset room code ref
         setLoading(false);
         return false;
       }
        // Additional check: even if committed, verify the user data exists in the snapshot
       if (!transactionResult.snapshot.child(memberId).exists()) {
          console.error(`Join transaction committed for room ${roomCode}, but user ${memberId} data is missing in the final snapshot. This indicates a potential issue.`);
          setError(`An inconsistency occurred while joining room ${roomCode}. Please try again.`);
          // Attempt cleanup of potentially partial state? Or just leave? Best to leave.
          try {
              await remove(userRef); // Try to clean up the potentially orphaned user entry
          } catch (cleanupError) {
              console.error("Error trying to clean up user entry after inconsistent transaction:", cleanupError);
          }
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
          const filteredMembers = loadedMembers.filter(m => m); // Filter out potentially null/deleted entries

           // Important: Update members state *before* checking currentUser existence
           setMembers(filteredMembers);
           console.log(`Members updated for room ${roomCode}:`, filteredMembers.length, "members");


         // Check if current user was removed (e.g., kicked or data inconsistency)
         // Perform this check *after* updating the members state and *only if* currentUser is still set locally
         if (currentUser) {
             const stillExists = filteredMembers.some(m => m.id === currentUser.id);
             if (!stillExists) {
                 console.warn(`Current user ${currentUser.id} no longer found in members list for room ${roomCode}. Leaving room.`);
                 setError("You seem to have been removed or disconnected from the room.");
                 // Avoid calling leaveRoom directly here to prevent loops. Let the component redirect.
                 cleanupListeners();
                 setCurrentUser(null); // Clear current user as they are no longer valid in this room
                 currentRoomCode.current = null; // Reset room code ref
                 setLoading(false); // Stop loading as the user is effectively out
             }
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
       console.error("General error during joinRoom process:", err);
       // Check if it's a FirebaseError and potentially contains 'maxretry' or similar codes
       let specificError = `Failed to join room ${roomCode}: ${err.message}`;
        if (err.code === 'maxretry' || (err.message && err.message.toLowerCase().includes('maxretry'))) {
            specificError = `Failed to join room ${roomCode} due to high contention or the room being full. Please try again.`;
            console.error("Join room failed specifically due to maxretry or related transaction failure.");
       } else {
            console.error(`Join room failed with an unexpected error: ${err.message || err}`);
       }
       setError(specificError);
       cleanupListeners(); // Ensure cleanup on any error
       setCurrentUser(null); // Clear current user on join failure
       currentRoomCode.current = null; // Reset room code ref
       setLoading(false);
       return false;
     }
   }, [db, currentUser, cleanupListeners, getRoomRef, getMembersRef, getUserRef, getMessagesRef, toast]); // Ensure all dependencies like `currentUser` are included


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
      // Use try-catch as cancel might fail if connection already lost
      try {
          await onDisconnect(userRef).cancel();
          console.log(`onDisconnect cancelled for ${userId} in room ${roomCode}.`);
      } catch (cancelError: any) {
          console.warn(`Could not cancel onDisconnect (may already be disconnected): ${cancelError.message}`);
      }


      // 2. Mark the user as offline immediately using update
      // Use try-catch as this might fail if permissions change or data is corrupt
      try {
          await update(userRef, { online: false, lastSeen: serverTimestamp() });
          console.log(`User ${userId} marked as offline in room ${roomCode}.`);
      } catch (updateError: any) {
          console.warn(`Could not mark user ${userId} as offline (may already be removed or connection issue): ${updateError.message}`);
          // Even if update fails, proceed with cleanup. The user might already be gone.
      }

      // Option B: Remove the user entirely (alternative to marking offline)
      // try {
      //     await remove(userRef);
      //     console.log(`User ${userId} removed from room ${roomCode}.`);
      // } catch (removeError: any) {
      //     console.warn(`Could not remove user ${userId} (may already be removed): ${removeError.message}`);
      // }


       // 3. Check if the room should be deleted (optional, based on your logic)
      // Use try-catch for the read operation as well
      try {
          const membersSnapshot = await get(membersRef);
          // Check if snapshot exists before trying to get value
          if (membersSnapshot.exists()) {
              const membersData = membersSnapshot.val();
              // Filter members who are explicitly marked as online
              const remainingOnlineMembers = membersData ? Object.values(membersData).filter((m: any) => m?.online === true) : [];

              if (remainingOnlineMembers.length === 0) {
                  console.log(`Last online user left room ${roomCode}. Optional: Consider deleting room.`);
                  // await remove(getRoomRef(roomCode)); // Uncomment to delete room
              } else {
                  console.log(`${remainingOnlineMembers.length} online members remaining in room ${roomCode}.`);
              }
          } else {
               console.log(`Members node for room ${roomCode} does not exist (already deleted or never created fully?). No cleanup needed.`);
          }
      } catch (readError: any) {
          console.error(`Error reading members to check for room deletion: ${readError.message}`);
      }


    } catch (err: any) {
      // Catch any unexpected errors during the leave process itself (outside specific DB calls)
      console.error("Unexpected error during leaveRoom process:", err);
      setError(`An unexpected error occurred while leaving room ${roomCode}: ${err.message}`);
      // Don't re-throw here, just log the error. Cleanup will happen anyway.
    } finally {
       // 4. Clean up listeners and reset state regardless of success/failure
       cleanupListeners();
       setCurrentUser(null); // Clear current user state *after* DB operations attempt
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
    const userRef = getUserRef(roomCode, currentUser.id); // Get user ref for update
    const newMessage: Message = {
      senderId: currentUser.id,
      text: text.trim(),
      timestamp: serverTimestamp(),
    };

    // Check if text is empty after trimming
     if (!newMessage.text) {
       console.log("Attempted to send an empty message.");
       return; // Don't send empty messages
     }

    try {
       // Use a single update operation for atomicity (send message + update lastSeen)
       // Note: This structure is slightly less common; usually, push is separate.
       // Pushing first and then updating lastSeen is also acceptable and often simpler.
       // Let's stick to the simpler push then update pattern.

       // 1. Push the new message
      const newMessageRef = push(messagesRef); // Get ref for the new message key
      await set(newMessageRef, newMessage); // Set the message data

      // 2. Update user's lastSeen timestamp
      await update(userRef, { lastSeen: serverTimestamp() });

      console.log(`Message sent by ${currentUser.id} in room ${roomCode}. Last seen updated.`);

    } catch (err: any) {
      console.error("Error sending message or updating lastSeen:", err);
      setError(`Failed to send message: ${err.message}`);
      throw err; // Re-throw for the component to potentially handle
    }
  }, [db, currentUser, getMessagesRef, getUserRef]); // Added getUserRef


  // --- Effects ---

  // Effect to cleanup listeners on component unmount
  React.useEffect(() => {
    return () => {
       // This cleanup runs when the ChatProvider itself unmounts
       if (currentUser && currentRoomCode.current) {
         console.log("ChatProvider unmounting, initiating leaveRoom cleanup for:", currentRoomCode.current);
         // Call leaveRoom directly - it handles its own state and cleanup
         leaveRoom(currentRoomCode.current);
       } else {
          // Ensure listeners are cleaned even if no user/room was active
          console.log("ChatProvider unmounting, running cleanupListeners.");
          cleanupListeners();
       }
    };
   // IMPORTANT: Include leaveRoom and cleanupListeners in dependencies
   // Ensure currentUser is also included if its state determines leaveRoom logic
  }, [currentUser, leaveRoom, cleanupListeners]);


   // Inactivity check (optional but good practice for cleanup)
   React.useEffect(() => {
    const interval = setInterval(async () => {
      if (!db || !currentRoomCode.current) return; // Only run if DB connected and in a room

      const currentCheckedRoom = currentRoomCode.current; // Capture the room code at the start of the interval
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
           // If the *current user* thought they were in this room, trigger leave state
           if (currentUser && currentRoomCode.current === currentCheckedRoom) {
              console.warn(`Inactivity check found current room ${currentCheckedRoom} deleted. Forcing local leave.`);
              setError("The room seems to have been deleted.");
              cleanupListeners();
              setCurrentUser(null);
              currentRoomCode.current = null;
              setLoading(false);
           }
           return;
        }

        const membersData = snapshot.val();
        const now = Date.now();
        let membersRemoved = false;
        const membersToRemove: string[] = [];

        for (const memberId in membersData) {
          const member = membersData[memberId] as Member;
          // Basic check: exists, has lastSeen as a number
          if (member && typeof member.lastSeen === 'number') {
            const timeSinceSeen = now - member.lastSeen;
             // Primary condition: User is marked offline AND inactive timeout passed
             // OR User is marked online BUT timeout is MUCH longer (e.g., 3x) indicating a stuck state
             const isStaleOffline = !member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT;
             const isStaleOnline = member.online && timeSinceSeen > MEMBER_INACTIVITY_TIMEOUT * 3; // 15 minutes for stuck online

            if (isStaleOffline || isStaleOnline) {
                const reason = isStaleOffline ? "inactive (offline)" : "inactive (stuck online)";
                console.log(`Scheduling removal of ${reason} member ${member.name} (${memberId}) from room ${currentCheckedRoom}. Last seen: ${new Date(member.lastSeen).toISOString()}`);
                membersToRemove.push(memberId);
            }
          } else if (member) {
             // Log members without a valid lastSeen timestamp for debugging
             console.warn(`Member ${member.name} (${memberId}) in room ${currentCheckedRoom} has missing or invalid 'lastSeen' timestamp:`, member.lastSeen);
             // Optional: Schedule removal if they are very old based on some other criteria? Or just log.
          }
        }

        // Batch remove members if any are identified
        if (membersToRemove.length > 0) {
            const updates: { [key: string]: null } = {};
             membersToRemove.forEach(id => {
                 updates[id] = null; // Setting path to null removes it
             });
            await update(membersRef, updates); // Perform batch removal via update
            console.log(`Removed ${membersToRemove.length} inactive members from room ${currentCheckedRoom}.`);
            membersRemoved = true;
        }


         // If members were removed, re-check if the room is now empty
         // This check should ideally happen *after* removal confirmation
         if(membersRemoved) {
             // Re-fetch the members data after removal
             const updatedSnapshot = await get(membersRef);
             // Abort if room changed again during the removal/re-fetch
             if (currentRoomCode.current !== currentCheckedRoom) return;

             const remainingMembers = updatedSnapshot.exists() ? Object.values(updatedSnapshot.val() || {}) : [];
             if (remainingMembers.length === 0) {
                console.log(`Room ${currentCheckedRoom} is empty after inactivity check. Optional: Consider deleting room.`);
                 // await remove(getRoomRef(currentCheckedRoom)); // Uncomment to delete room

                 // If the current user was in this now-empty room, clear their state
                 if (currentUser && currentRoomCode.current === currentCheckedRoom) {
                     console.log(`Current user was in room ${currentCheckedRoom} which became empty. Forcing local leave.`);
                     setError("The room has become empty.");
                     cleanupListeners();
                     setCurrentUser(null);
                     currentRoomCode.current = null;
                     setLoading(false);
                 }
             }
         }

      } catch (err: any) {
        // Avoid setting global error for background task failures
        console.error(`Error during inactivity check for room ${currentCheckedRoom}:`, err.message || err);
      }
    }, MEMBER_INACTIVITY_TIMEOUT / 2); // Check periodically (e.g., every 2.5 minutes)

    return () => clearInterval(interval);
    // Add dependencies: currentUser is needed to check if the current user needs cleanup
   }, [db, currentUser, getMembersRef, getUserRef, getRoomRef, cleanupListeners]); // Added getRoomRef, cleanupListeners, currentUser


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

