'use client';

import * as React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogIn, PlusCircle } from 'lucide-react';
import { useChat } from '@/context/chat-context';
import { useToast } from '@/hooks/use-toast';
import { generateRoomCode } from '@/lib/utils'; // Assuming you have this utility

export default function HomeComponent() {
  const [roomCode, setRoomCode] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const router = useRouter();
  const { checkRoomExists, createRoom } = useChat();
  const { toast } = useToast();

  const handleCreateRoom = async () => {
    setIsCreating(true);
    try {
      const newRoomCode = generateRoomCode();
      await createRoom(newRoomCode);
      router.push(`/room/${newRoomCode}`);
    } catch (error: any) {
      console.error('Error creating room:', error);
      toast({
        variant: "destructive",
        title: "Error creating room",
        description: error.message || "Could not create a new room. Please try again.",
      });
      setIsCreating(false);
    }
    // No need to set isCreating false here, redirection handles it
  };

  const handleJoinRoom = async () => {
    if (!roomCode.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid Room Code",
        description: "Please enter a room code.",
      });
      return;
    }
    setIsJoining(true);
    try {
      const exists = await checkRoomExists(roomCode);
      if (exists) {
        router.push(`/room/${roomCode}`);
      } else {
        toast({
          variant: "destructive",
          title: "Room Not Found",
          description: "The entered room code does not exist.",
        });
        setIsJoining(false);
      }
    } catch (error: any) {
      console.error('Error joining room:', error);
      toast({
        variant: "destructive",
        title: "Error joining room",
        description: error.message || "Could not join the room. Please check the code and try again.",
      });
      setIsJoining(false);
    }
    // No need to set isJoining false here on success, redirection handles it
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRoomCode(e.target.value.toUpperCase()); // Keep room codes consistent
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleJoinRoom();
    }
  };

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-3xl font-bold text-primary">NOTRACE</CardTitle>
        <CardDescription>Anonymous & Ephemeral Chat Rooms</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Button
          onClick={handleCreateRoom}
          disabled={isCreating || isJoining}
          className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
          size="lg"
        >
          <PlusCircle className="mr-2 h-5 w-5" />
          {isCreating ? 'Creating Room...' : 'Create New Room'}
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              Or Join Existing Room
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Input
            type="text"
            placeholder="Enter Room Code"
            value={roomCode}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isCreating || isJoining}
            className="text-center tracking-widest uppercase"
            maxLength={6} // Assuming room codes are 6 characters long
          />
          <Button
            onClick={handleJoinRoom}
            disabled={isCreating || isJoining || !roomCode.trim()}
            className="w-full"
            variant="secondary"
            size="lg"
          >
             <LogIn className="mr-2 h-5 w-5" />
            {isJoining ? 'Joining Room...' : 'Join Room'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
