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
import { Send, LogOut, Download, Users, AlertTriangle, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

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
    roomExists,
    loading,
    error,
  } = useChat();
  const [newMessage, setNewMessage] = useState('');
  const [isLeaving, setIsLeaving] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

   useEffect(() => {
    const join = async () => {
      const joined = await joinRoom(roomCode);
      if (!joined) {
        // If joinRoom returns false (e.g., room full or doesn't exist), redirect
        toast({
          variant: "destructive",
          title: "Failed to Join Room",
          description: `Could not join room ${roomCode}. It might be full or no longer exists.`,
        });
        router.push('/');
      } else {
         // Focus input after joining
        inputRef.current?.focus();
      }
    };
    join();

    // Attempt to scroll down initially and whenever messages/members change
    scrollToBottom();

     // Handle user leaving the page (close tab, browser, navigate away)
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Note: Standard browsers might not display custom messages here for security reasons.
      // The primary goal is to trigger the leaveRoom logic.
      leaveRoom(roomCode);
      // event.preventDefault(); // Not strictly necessary for cleanup but standard practice
      // event.returnValue = ''; // For older browsers
    };

     window.addEventListener('beforeunload', handleBeforeUnload);


    // Cleanup function for when the component unmounts or roomCode changes
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Ensure leaveRoom is called if the component unmounts for other reasons
      // Check if currentUser exists before leaving, as it might be null if join failed
      if (currentUser) {
        leaveRoom(roomCode);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, joinRoom, leaveRoom, router, toast]); // currentUser dependency removed to avoid loop on initial load

  useEffect(() => {
    scrollToBottom();
  }, [messages, members, scrollToBottom]);

  useEffect(() => {
    if (error) {
      toast({
        variant: "destructive",
        title: "Room Error",
        description: error,
      });
      router.push('/');
    }
  }, [error, router, toast]);

   useEffect(() => {
    // Check room existence explicitly after initial load or if currentUser becomes null
    const checkExistence = async () => {
      if (!loading && !currentUser && !error) {
        const exists = await roomExists(roomCode);
        if (!exists) {
          toast({
            variant: "destructive",
            title: "Room Not Found",
            description: `Room ${roomCode} does not exist.`,
          });
          router.push('/');
        }
      }
    };
    checkExistence();
   }, [loading, currentUser, roomCode, roomExists, router, toast, error]);


  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!newMessage.trim() || !currentUser) return;

    try {
      await sendMessage(roomCode, newMessage);
      setNewMessage('');
      scrollToBottom(); // Scroll after sending
       inputRef.current?.focus(); // Keep focus on input
    } catch (err: any) {
      console.error('Error sending message:', err);
      toast({
        variant: "destructive",
        title: "Send Error",
        description: err.message || "Could not send message.",
      });
    }
  };

  const handleLeaveRoom = async (exportChat: boolean) => {
    setIsLeaving(true);
    if (exportChat) {
      handleExportChat(); // Export first
    }
    try {
      await leaveRoom(roomCode);
      router.push('/');
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
       toast({ title: "Export Failed", description: "Chat is empty." });
       return;
    }

    const pdf = new jsPDF();
    pdf.setFontSize(16);
    pdf.text(`NOTRACE Chat - Room: ${roomCode}`, 14, 15);
    pdf.setFontSize(10);
    pdf.text(`Exported on: ${format(new Date(), 'Pp')}`, 14, 22);
    pdf.setLineWidth(0.1);
    pdf.line(14, 25, 196, 25); // Separator line

    let yPos = 35;
    const pageHeight = pdf.internal.pageSize.height;
    const margin = 15; // Top/bottom margin

    messages.forEach((msg) => {
      const timestamp = msg.timestamp ? format(new Date(msg.timestamp), 'p') : 'Sending...';
      const senderName = members.find(m => m.id === msg.senderId)?.name || 'Unknown';
      const messageLine = `[${timestamp}] ${senderName}: ${msg.text}`;

      // Split lines manually to handle wrapping
      const splitLines = pdf.splitTextToSize(messageLine, 180); // Adjust width as needed (page width - margins)

      if (yPos + (splitLines.length * 5) > pageHeight - margin) { // Check if content exceeds page height
        pdf.addPage();
        yPos = margin; // Reset Y position for new page
         pdf.line(14, margin - 5, 196, margin - 5); // Separator line at top of new page
      }

      pdf.text(splitLines, 14, yPos);
      yPos += (splitLines.length * 5) + 2; // Increment Y position (line height + spacing)
    });


    try {
      pdf.save(`notrace_chat_${roomCode}_${format(new Date(), 'yyyyMMdd_HHmmss')}.pdf`);
      toast({ title: "Export Successful", description: "Chat history saved as PDF." });
    } catch (error) {
       console.error("Error generating PDF:", error);
       toast({ variant: "destructive", title: "Export Failed", description: "Could not generate PDF." });
    }

  };


  if (loading || !currentUser) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-primary mb-4"></div>
        <p className="text-muted-foreground">Joining room {roomCode}...</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
    <Card className="w-full h-[85vh] max-h-[900px] flex flex-col shadow-lg border border-border bg-card">
      <CardHeader className="flex flex-row items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
           <CardTitle className="text-xl md:text-2xl font-semibold text-primary truncate">Room: {roomCode}</CardTitle>
           <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="cursor-help">
                <Users className="h-4 w-4 mr-1" /> {members.length} / 8
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="font-semibold mb-1">Members:</p>
              <ul className="list-disc list-inside text-sm">
                {members.map(m => <li key={m.id}>{m.name} {m.id === currentUser.id ? '(You)' : ''}</li>)}
              </ul>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
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
                      <LogOut className="h-5 w-5" />
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
                  Are you sure you want to leave the room? Your chat history in this room will be lost unless you export it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col sm:flex-row gap-2 mt-2">
                 <AlertDialogAction
                   onClick={() => handleLeaveRoom(true)} // Leave AND Export
                   className="w-full sm:w-auto"
                   disabled={isLeaving || messages.length === 0}
                 >
                   <Download className="mr-2 h-4 w-4"/> Export & Leave
                 </AlertDialogAction>
                 <AlertDialogAction
                   onClick={() => handleLeaveRoom(false)} // Leave WITHOUT Export
                   variant="destructive"
                   className="w-full sm:w-auto"
                   disabled={isLeaving}
                 >
                   <LogOut className="mr-2 h-4 w-4"/> Leave Without Export
                 </AlertDialogAction>
                 <AlertDialogCancel className="w-full sm:w-auto mt-2 sm:mt-0" disabled={isLeaving}>Cancel</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>

      <CardContent ref={scrollAreaRef} className="flex-grow p-0 overflow-hidden">
          <ScrollArea className="h-full w-full p-4">
             {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-center">
                <Info className="h-8 w-8 mb-2"/>
                <p className="font-semibold">Welcome to the room!</p>
                <p className="text-sm">Messages you send will appear here.</p>
                <p className="text-xs mt-4">Remember: Chats are ephemeral and not stored long-term.</p>
              </div>
            )}
            {messages.map((msg, index) => {
              const sender = members.find(m => m.id === msg.senderId);
              const isCurrentUserMsg = msg.senderId === currentUser.id;
              const senderName = sender?.name || '...'; // Show ellipsis if member not found yet
              const senderInitial = senderName.charAt(0).toUpperCase();
               const timestamp = msg.timestamp ? format(new Date(msg.timestamp), 'p') : '...'; // Sending indicator

              // Check if the previous message was from the same sender
              const prevMsg = index > 0 ? messages[index - 1] : null;
              const showSenderInfo = !prevMsg || prevMsg.senderId !== msg.senderId;

              return (
                <div
                  key={msg.id || `msg-${index}`} // Use index as fallback key if id isn't available yet
                  className={`flex mb-3 ${isCurrentUserMsg ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`flex items-end gap-2 max-w-[80%] ${isCurrentUserMsg ? 'flex-row-reverse' : 'flex-row'}`}>
                     {!isCurrentUserMsg && (
                      <Avatar className={`h-6 w-6 ${showSenderInfo ? 'opacity-100' : 'opacity-0'}`}>
                          <AvatarFallback className="text-xs bg-secondary text-secondary-foreground">{senderInitial}</AvatarFallback>
                      </Avatar>
                     )}
                    <div
                      className={`flex flex-col rounded-lg px-3 py-2 ${
                        isCurrentUserMsg
                          ? 'bg-primary text-primary-foreground rounded-br-none'
                          : 'bg-muted text-muted-foreground rounded-bl-none'
                      }`}
                    >
                      {!isCurrentUserMsg && showSenderInfo && (
                        <p className="text-xs font-semibold mb-1">{senderName}</p>
                      )}
                      <p className="text-sm break-words whitespace-pre-wrap">{msg.text}</p>
                      <p className={`text-xs mt-1 ${isCurrentUserMsg ? 'text-primary-foreground/70' : 'text-muted-foreground/70'} text-right`}>
                        {timestamp}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Marker div for scrolling */}
            <div ref={messagesEndRef} />
          </ScrollArea>
      </CardContent>

      <CardFooter className="p-4 border-t">
        <form onSubmit={handleSendMessage} className="flex w-full items-center gap-2">
          <Input
            ref={inputRef}
            type="text"
            placeholder={`Chatting as ${currentUser.name}...`}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            className="flex-grow"
            disabled={isLeaving}
            autoComplete="off"
          />
          <Button type="submit" size="icon" disabled={!newMessage.trim() || isLeaving}>
            <Send className="h-5 w-5" />
             <span className="sr-only">Send Message</span>
          </Button>
        </form>
      </CardFooter>
    </Card>
     </TooltipProvider>
  );
}
