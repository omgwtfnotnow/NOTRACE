import ChatRoom from '@/components/chat-room';

export default function RoomPage({ params }: { params: { roomCode: string } }) {
  return <ChatRoom roomCode={params.roomCode} />;
}

// Optional: Add metadata generation if needed
// export async function generateMetadata({ params }: { params: { roomCode: string } }) {
//   return {
//     title: `NOTRACE Room: ${params.roomCode}`,
//   };
// }
