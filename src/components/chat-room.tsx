'use client';

import * as React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useChat, type Message, type Member } from '@/context/chat-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Send, LogOut, Download, Users, AlertTriangle, Info, Loader2 } from 'lucide-react'; // Added Loader2
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

// Define the constant locally within the component as it's used for display here
const MAX_MEMBERS = 8;

interface ChatRoomProps {
  roomCode: string;
}

export default function ChatRoom({ roomCode }: ChatRoomProps) {
  const {
    joinRoom,
    leaveRoom,
    sendMessage,
    messages,
    members,
    currentUser,
    // roomExists, // Keep for potential future use, but joinRoom handles existence now
    loading: chatLoading, // Rename to avoid conflict
    error: chatError, // Rename to avoid conflict
  } = useChat();
  const [newMessage, setNewMessage] = useState('');
  const [isLeaving, setIsLeaving] = useState(false);
  const [isJoining, setIsJoining] = useState(true); // Start in joining state
   const [joinError, setJoinError] = useState<string | null>(null); // Specific state for join errors
  const router = useRouter();
  const { toast } = useToast();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

   // --- Join Room Effect ---
   useEffect(() => {
    let isMounted = true; // Flag to prevent state updates on unmounted component
    setIsJoining(true); // Ensure joining state is active
    setJoinError(null); // Clear previous join errors

    const attemptJoin = async () => {
      console.log(`Attempting to join room: ${roomCode}`);
      try {
        const joinedSuccessfully = await joinRoom(roomCode);

        if (!isMounted) return; // Don't update state if unmounted

        if (joinedSuccessfully) {
          console.log(`Successfully joined room ${roomCode}. Focusing input.`);
          setIsJoining(false);
          setJoinError(null); // Clear any lingering join errors
          inputRef.current?.focus(); // Focus input after successful join
        } else {
          // joinRoom returned false, meaning join failed (room full, doesn't exist, etc.)
          // The context should have set an error message.
           const failureReason = chatError || `Could not join room ${roomCode}. It might be full, deleted, or unavailable.`;
           console.error(`Failed to join room ${roomCode}. Reason from context (or default): ${failureReason}`);
           setJoinError(failureReason); // Use the error from context
           toast({
             variant: "destructive",
             title: "Failed to Join Room",
             description: failureReason + " Redirecting...",
             duration: 5000, // Give user time to read before redirect
           });
           setIsJoining(false); // Stop showing joining indicator
           // Redirect after a short delay to allow toast visibility
           setTimeout(() => {
              if (isMounted) router.push('/');
           }, 3000);
        }
      } catch (error: any) {
         // Catch errors thrown by joinRoom itself (e.g., DB not init)
         if (!isMounted) return;
         console.error(`Error thrown during joinRoom attempt for ${roomCode}:`, error);
         const failureReason = error.message || `An unexpected error occurred while trying to join room ${roomCode}.`;
         setJoinError(failureReason);
         toast({
           variant: "destructive",
           title: "Error Joining Room",
           description: failureReason + " Redirecting...",
           duration: 5000,
         });
         setIsJoining(false);
         setTimeout(() => {
           if (isMounted) router.push('/');
         }, 3000);
      }
    };

    attemptJoin();

    return () => {
      isMounted = false; // Mark as unmounted on cleanup
       console.log("ChatRoom component unmounting or roomCode changing.");
       // Leave room logic is now handled by the ChatProvider's unmount effect
       // and the beforeunload handler
    };
   }, [roomCode, joinRoom, router, toast, chatError]); // Re-added chatError to react to context updates


   // --- Handle Browser Close/Navigation ---
   useEffect(() => {
     const handleBeforeUnload = (event: BeforeUnloadEvent) => {
       console.log("beforeunload event triggered. Attempting to leave room.");
       // This is best-effort. Browser might kill the process before async ops complete.
       // Rely more on onDisconnect and inactivity checks.
       if (currentUser) { // Check if user actually joined
         leaveRoom(roomCode);
       }
       // Standard practice for older browsers, though modern ones ignore custom messages.
       // event.preventDefault();
       // event.returnValue = '';
     };

     window.addEventListener('beforeunload', handleBeforeUnload);

     return () => {
       window.removeEventListener('beforeunload', handleBeforeUnload);
     };
     // Depends on currentUser to know if leaveRoom is necessary
   }, [leaveRoom, roomCode, currentUser]);


  // --- Scroll Effect ---
  useEffect(() => {
    // Only scroll if not actively joining (prevents scrolling during initial load)
    if (!isJoining) {
      scrollToBottom();
    }
  }, [messages, members, scrollToBottom, isJoining]); // Add isJoining dependency


  // --- General Error Handling (from context after join) ---
   useEffect(() => {
    // Handle errors that might occur *after* joining (e.g., listener errors)
    // Ignore errors during the initial join phase as they are handled separately
    // Also ignore errors if we already have a specific joinError set.
    if (chatError && !isJoining && !joinError) {
      console.warn(`Chat context error occurred after joining: ${chatError}`);
      toast({
        variant: "destructive",
        title: "Room Error",
        description: `An error occurred: ${chatError}. You might be disconnected. Redirecting...`,
      });
       // Redirect if a persistent error occurs after joining
      setTimeout(() => router.push('/'), 3000);
    }
   }, [chatError, isJoining, joinError, router, toast]);


  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!newMessage.trim() || !currentUser || isLeaving || isJoining) return;

    const messageToSend = newMessage;
    setNewMessage(''); // Clear input immediately for better UX

    try {
      await sendMessage(roomCode, messageToSend);
      // scrollToBottom(); // Let the useEffect handle scrolling
       inputRef.current?.focus(); // Keep focus on input
    } catch (err: any) {
      console.error('Error sending message:', err);
      setNewMessage(messageToSend); // Restore message on error
      toast({
        variant: "destructive",
        title: "Send Error",
        description: err.message || "Could not send message.",
      });
    }
  };

  const handleLeaveRoom = async (exportChat: boolean) => {
    setIsLeaving(true);
    if (exportChat && messages.length > 0) {
      handleExportChat(); // Export first if requested and possible
    } else if (exportChat && messages.length === 0) {
       toast({ title: "Export Skipped", description: "Chat is empty, nothing to export." });
    }

    try {
      await leaveRoom(roomCode);
      // Redirect happens implicitly as currentUser becomes null,
      // or ChatProvider effect might handle it. Explicit redirect for certainty.
      router.push('/');
      toast({ title: "Left Room", description: `You have left room ${roomCode}.`}); // Add confirmation toast
    } catch (err: any) {
      console.error('Error leaving room:', err);
      toast({
        variant: "destructive",
        title: "Leave Error",
        description: err.message || "Could not leave room properly.",
      });
      setIsLeaving(false); // Allow retry if leaving failed
    }
     // No need to set isLeaving false on success, redirection handles it
  };

  const handleExportChat = () => {
    if (!messages.length) {
       // Toast handled in handleLeaveRoom if called from there
       return;
    }

    const pdf = new jsPDF();
    pdf.setFontSize(16);
    pdf.text(`NOTRACE Chat - Room: ${roomCode}`, 14, 15);
    pdf.setFontSize(10);
    pdf.text(`Exported on: ${format(new Date(), 'Pp')} by ${currentUser?.name || 'User'}`, 14, 22);
    pdf.setLineWidth(0.1);
    pdf.line(14, 25, 196, 25); // Separator line

    let yPos = 35;
    const pageHeight = pdf.internal.pageSize.height;
    const margin = 15; // Top/bottom margin
    const lineHeight = 5; // Approximate line height based on font size
    const spacing = 2; // Space between messages

    messages.forEach((msg) => {
      const timestamp = typeof msg.timestamp === 'number' ? format(new Date(msg.timestamp), 'p') : 'Sending...';
      const senderName = members.find(m => m.id === msg.senderId)?.name || 'Unknown';
      // Sanitize text slightly for PDF (basic example)
      const messageText = msg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const messageLine = `[${timestamp}] ${senderName}: ${messageText}`;


      // Split lines manually to handle wrapping
      const splitLines = pdf.splitTextToSize(messageLine, 180); // Page width - margins
      const messageHeight = splitLines.length * lineHeight;

      // Check if content exceeds page height before adding it
      if (yPos + messageHeight > pageHeight - margin) {
        pdf.addPage();
        yPos = margin; // Reset Y position for new page
         // Optional: Add header to new page if needed
         // pdf.line(14, margin - 5, 196, margin - 5); // Separator line at top of new page
      }

      pdf.text(splitLines, 14, yPos);
      yPos += messageHeight + spacing; // Increment Y position
    });


    try {
      pdf.save(`notrace_chat_${roomCode}_${format(new Date(), 'yyyyMMdd_HHmmss')}.pdf`);
      toast({ title: "Export Successful", description: "Chat history saved as PDF." });
    } catch (error) {
       console.error("Error generating PDF:", error);
       toast({ variant: "destructive", title: "Export Failed", description: "Could not generate PDF." });
    }

  };

   // --- Render Loading State ---
   if (isJoining || chatLoading) { // Show loading if component state is joining OR context is loading
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Loader2 className="h-16 w-16 animate-spin text-primary mb-4" />
        <p className="text-lg font-semibold text-foreground">Joining room {roomCode}...</p>
        <p className="text-muted-foreground">Please wait while we connect you.</p>
        {/* Don't show joinError here, wait for the final error state render */}
      </div>
    );
  }

  // --- Render Room Not Found or Join Error State ---
   // This state triggers if joining finished (isJoining=false) BUT currentUser is still null OR joinError is set.
   if ((!currentUser && !isJoining) || joinError) {
     return (
       <div className="flex flex-col items-center justify-center h-full p-8 text-center">
         <AlertTriangle className="h-16 w-16 text-destructive mb-4" />
         <p className="text-xl font-semibold text-destructive">Could Not Enter Room</p>
          <p className="text-muted-foreground mt-2 max-w-md">
           {joinError || chatError || `Unable to join room ${roomCode}. It might be full, deleted, or you might have been disconnected.`}
         </p>
         <Button onClick={() => router.push('/')} className="mt-6">
            Go Back Home
          </Button>
       </div>
     );
   }


  // --- Render Main Chat Room ---
   // Safeguard: If loading is done, join error is not set, but user is somehow still null.
   if (!currentUser) {
     console.error("ChatRoom render reached without currentUser after loading/joining/error checks.");
     return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <AlertTriangle className="h-16 w-16 text-destructive mb-4" />
            <p className="text-xl font-semibold text-destructive">Connection Issue</p>
            <p className="text-muted-foreground mt-2 max-w-md">
              There was an issue establishing your connection. Please try rejoining.
            </p>
            <Button onClick={() => router.push('/')} className="mt-6">
              Go Back Home
            </Button>
        </div>
        );
   }


  // Main chat interface rendered only if currentUser is confirmed
  return (
    <TooltipProvider>
    <Card className="w-full h-[85vh] max-h-[900px] flex flex-col shadow-lg border border-border bg-card">
      <CardHeader className="flex flex-row items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3 overflow-hidden"> {/* Added overflow-hidden */}
           <CardTitle className="text-xl md:text-2xl font-semibold text-primary truncate">Room: {roomCode}</CardTitle>
           <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="cursor-help flex-shrink-0"> {/* Added flex-shrink-0 */}
                <Users className="h-4 w-4 mr-1" /> {members.filter(m => m.online).length} / {MAX_MEMBERS}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="font-semibold mb-1">Online Members ({members.filter(m => m.online).length}):</p>
              <ul className="list-disc list-inside text-sm max-h-40 overflow-y-auto">
                 {members.filter(m => m.online).length === 0 && <li>No one else is here.</li>}
                {members.filter(m => m.online).map(m => (
                    <li key={m.id}>{m.name} {m.id === currentUser.id ? '(You)' : ''}</li>
                 ))}
                 {members.filter(m => !m.online).length > 0 && (
                    <>
                    <hr className="my-1"/>
                    <p className="font-semibold my-1 text-muted-foreground">Offline:</p>
                    {members.filter(m => !m.online).map(m => (
                     <li key={m.id} className="text-muted-foreground/80">{m.name}</li>
                    ))}
                    </>
                 )}

              </ul>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0"> {/* Added flex-shrink-0 */}
            <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleExportChat} disabled={isLeaving || messages.length === 0}>
                 <Download className="h-5 w-5" />
                 <span className="sr-only">Export Chat</span>
                </Button>
            </TooltipTrigger>
             <TooltipContent side="bottom">
               {messages.length === 0 ? "Chat is empty" : "Export Chat (PDF)"}
            </TooltipContent>
           </Tooltip>

           <AlertDialog>
             <Tooltip>
               <TooltipTrigger asChild>
                <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="icon" disabled={isLeaving}>
                      {isLeaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogOut className="h-5 w-5" />}
                      <span className="sr-only">Leave Room</span>
                    </Button>
                </AlertDialogTrigger>
               </TooltipTrigger>
                <TooltipContent side="bottom">Leave Room</TooltipContent>
             </Tooltip>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave Room?</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to leave the room? Your chat history in this room will be lost unless you export it first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col sm:flex-row gap-2 mt-4">
                 <Button
                   onClick={() => handleLeaveRoom(true)}
                   className="w-full sm:w-auto"
                   disabled={isLeaving || messages.length === 0}
                   variant="outline"
                 >
                   <Download className="mr-2 h-4 w-4"/> {messages.length === 0 ? "Chat Empty" : "Export & Leave"}
                 </Button>
                 <Button
                   onClick={() => handleLeaveRoom(false)}
                   variant="destructive"
                   className="w-full sm:w-auto"
                   disabled={isLeaving}
                 >
                  {isLeaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <LogOut className="mr-2 h-4 w-4"/>}
                   Leave Without Export
                 </Button>
                 <AlertDialogCancel className="w-full sm:w-auto mt-2 sm:mt-0" disabled={isLeaving}>Cancel</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>

      <CardContent ref={scrollAreaRef} className="flex-grow p-0 overflow-hidden">
          <ScrollArea className="h-full w-full p-4">
             {messages.length === 0 && !isJoining && ( // Show welcome only after joining and if no messages
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-center px-4">
                <Info className="h-10 w-10 mb-3 text-primary"/>
                <p className="text-lg font-semibold text-foreground">Welcome, {currentUser.name}!</p>
                <p className="text-sm">You're in room <span className="font-mono text-primary">{roomCode}</span>.</p>
                <p className="text-sm mt-2">Messages you send will appear here. Start chatting!</p>
                <p className="text-xs mt-6 bg-secondary text-secondary-foreground p-2 rounded-md">
                    Remember: Chats are ephemeral and not stored long-term. Be respectful.
                </p>
              </div>
            )}
            {messages.map((msg, index) => {
              const sender = members.find(m => m.id === msg.senderId);
              const isCurrentUserMsg = msg.senderId === currentUser.id;
               // Use a more robust fallback if sender is somehow missing after join
               const senderName = sender?.name || (isCurrentUserMsg ? currentUser.name : 'Unknown User');
              const senderInitial = senderName.charAt(0).toUpperCase();
               const timestamp = typeof msg.timestamp === 'number'
                ? format(new Date(msg.timestamp), 'p')
                : '...'; // Sending indicator


              // Determine if sender info should be shown (first message or sender change)
              const prevMsg = index > 0 ? messages[index - 1] : null;
              const showSenderInfo = !prevMsg || prevMsg.senderId !== msg.senderId;
              // Check if timestamp should be shown (last message or significant time gap?)
               // For simplicity, show timestamp always for now. Could add time gap logic later.

              return (
                <div
                  key={msg.id || `msg-${index}-${msg.timestamp}`} // Better fallback key
                  className={`flex mb-1 ${isCurrentUserMsg ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`flex items-start gap-2 max-w-[85%] md:max-w-[75%] ${isCurrentUserMsg ? 'flex-row-reverse' : 'flex-row'}`}>
                     {!isCurrentUserMsg && (
                      <Avatar className={`h-6 w-6 mt-1 ${showSenderInfo ? 'opacity-100' : 'opacity-0'}`}>
                          {/* Add tooltip to avatar? */}
                          <AvatarFallback className="text-xs bg-secondary text-secondary-foreground">{senderInitial}</AvatarFallback>
                      </Avatar>
                     )}
                     {isCurrentUserMsg && (
                         <div className="w-6 flex-shrink-0"></div> // Placeholder to align messages
                     )}
                    <div
                       className={`flex flex-col rounded-lg px-3 py-1.5 shadow-sm ${
                        isCurrentUserMsg
                          ? 'bg-primary text-primary-foreground rounded-br-none'
                          : 'bg-card border rounded-bl-none' // Use card for non-user messages
                      } ${showSenderInfo ? 'mt-2' : ''}`} // Add margin top if sender info is shown
                    >
                      {!isCurrentUserMsg && showSenderInfo && (
                         <p className="text-xs font-semibold mb-0.5 text-primary">{senderName}</p>
                      )}
                      <p className="text-sm break-words whitespace-pre-wrap">{msg.text}</p>
                       <p className={`text-[10px] mt-1 ${isCurrentUserMsg ? 'text-primary-foreground/70' : 'text-muted-foreground/70'} ${isCurrentUserMsg ? 'text-right' : 'text-left'}`}>
                        {timestamp}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Marker div for scrolling */}
            <div ref={messagesEndRef} className="h-1" />
          </ScrollArea>
      </CardContent>

      <CardFooter className="p-2 border-t">
        <form onSubmit={handleSendMessage} className="flex w-full items-center gap-2">
          <Input
            ref={inputRef}
            type="text"
            placeholder={`Chatting as ${currentUser.name}...`}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            className="flex-grow"
            disabled={isLeaving || isJoining} // Disable during leaving/joining
            autoComplete="off"
            maxLength={500} // Add a max length
          />
          <Button type="submit" size="icon" disabled={!newMessage.trim() || isLeaving || isJoining}>
            <Send className="h-5 w-5" />
             <span className="sr-only">Send Message</span>
          </Button>
        </form>
      </CardFooter>
    </Card>
     </TooltipProvider>
  );
}

