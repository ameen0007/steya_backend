// server.js - SIMPLE MESSAGE STATUS SYSTEM (sent/seen only)
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import connectDB from './config/db.js';
import Chat from './models/chatmodal.js';
import ChatRoom from './models/RoomChatmodal.js';
import User from './models/userModal.js';
import Room from './models/RoomSchema.js';

import dotenv from 'dotenv';
import { sendPushNotification } from './utils/pushNotificationService.js';
import { startCleanupJob } from './services/cleanupJob.js';

dotenv.config();
connectDB();

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

startCleanupJob();
console.log('✅ Auto-cleanup job started - will run daily at 3 AM');

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

const onlineUsers = new Map();
const userRooms = new Map();
const userSockets = new Map();

// Rate limiting
const MESSAGE_RATE_LIMIT = 10;
const userMessageCounts = new Map();

const cleanupOldMessages = () => {
  const now = Date.now();
  for (const [userId, messages] of userMessageCounts.entries()) {
    const recent = messages.filter(time => now - time < 60000);
    if (recent.length === 0) {
      userMessageCounts.delete(userId);
    } else {
      userMessageCounts.set(userId, recent);
    }
  }
};

setInterval(cleanupOldMessages, 60000);

const broadcastOnlineStatus = async (roomId, excludedSocketId = null) => {
  try {
    const roomIdStr = roomId.toString();
    const room = await ChatRoom.findById(roomIdStr).populate('participants', '_id');
    if (!room) {
      console.warn(`⚠️ Room ${roomIdStr} not found for status broadcast`);
      return;
    }

    const onlineStatuses = {};
    for (const participant of room.participants) {
      const participantId = participant._id.toString();
      onlineStatuses[participantId] = onlineUsers.has(participantId);
    }

    // console.log(`📢 Broadcasting online status for room ${roomIdStr}:`, onlineStatuses);

    if (excludedSocketId) {
      io.to(roomIdStr).except(excludedSocketId).emit('onlineStatuses', {
        roomId: roomIdStr,
        statuses: onlineStatuses
      });
    } else {
      io.to(roomIdStr).emit('onlineStatuses', {
        roomId: roomIdStr,
        statuses: onlineStatuses
      });
    }
  } catch (error) {
    console.error('❌ Error broadcasting online status:', error);
  }
};

const notifyParticipantsOfChatUpdate = async (roomId, excludedUserId = null) => {
  try {
    const room = await ChatRoom.findById(roomId).populate('participants', '_id');
    if (!room) return;

    // console.log(`📢 Notifying participants of chat list update for room ${roomId}`);

    room.participants.forEach(participant => {
      const participantId = participant._id.toString();

      if (excludedUserId && participantId === excludedUserId.toString()) {
        return;
      }

      io.to(`user_${participantId}`).emit('newMessageInAnyRoom', {
        roomId: roomId.toString(),
        timestamp: new Date()
      });
    });
  } catch (error) {
    console.error('❌ Error notifying participants:', error);
  }
};

io.use((socket, next) => {
  // console.log(`🔄 Incoming connection from:`, socket.handshake.address);
  next();
});

io.on('connection', (socket) => {
  // console.log('✅ User connected', socket.id, 'at', new Date().toISOString());

  socket.on('userOnline', ({ userId }) => {
    if (!userId) return;

    const userIdStr = userId.toString();
    onlineUsers.set(userIdStr, socket.id);
    userSockets.set(socket.id, userIdStr);

    // console.log(`👤 User ${userIdStr} app is online (socket: ${socket.id})`);
  });

  socket.on('joinUserRoom', ({ userId }) => {
    if (!userId) return;

    const userIdStr = userId.toString();
    const userRoomId = `user_${userIdStr}`;

    socket.join(userRoomId);
    userSockets.set(socket.id, userIdStr);
    onlineUsers.set(userIdStr, socket.id);

    // console.log(`👤 User ${userIdStr} joined personal room: ${userRoomId}`);
  });

  socket.on('leaveUserRoom', ({ userId }) => {
    if (!userId) return;

    const userIdStr = userId.toString();
    const userRoomId = `user_${userIdStr}`;

    socket.leave(userRoomId);
    // console.log(`👤 User ${userIdStr} left personal room: ${userRoomId}`);
  });

  socket.on('joinRoom', async ({ roomId, userId }) => {
    // console.log(`🎯 JOIN ROOM: User ${userId} → Room ${roomId}`);

    if (!roomId || !userId) {
      socket.emit('error', { message: 'Missing roomId or userId' });
      return;
    }

    const userIdStr = userId.toString();
    const roomIdStr = roomId.toString();

    socket.join(roomIdStr);
    socket.userId = userIdStr;

    if (!userRooms.has(userIdStr)) {
      userRooms.set(userIdStr, new Set());
    }
    userRooms.get(userIdStr).add(roomIdStr);

    onlineUsers.set(userIdStr, socket.id);
    userSockets.set(socket.id, userIdStr);

    try {
      const [chatRoom, chat] = await Promise.all([
        ChatRoom.findById(roomIdStr)
          .populate('participants', '_id name picture')
          .lean(),
        Chat.findOne({ roomId: roomIdStr }).lean()
      ]);

      if (!chatRoom) {
        socket.emit('error', { message: 'Chat room not found' });
        return;
      }

      const userRole = chatRoom.participants[0]._id.toString() === userIdStr
        ? 'inquirer'
        : 'owner';

      let currentState = 'START';
      let messages = [];
      let conversationMode = 'hybrid';

      if (chat) {
        conversationMode = chat.conversationMode || 'hybrid';
        currentState = chat.currentState || 'START';

        if (chat.messages.length > 0) {
          messages = chat.messages.map(msg => ({
            _id: msg._id?.toString(),
            sender: msg.sender,
            optionId: msg.optionId,
            option: msg.option,
            text: msg.text,
            messageType: msg.messageType || 'option',
            nextState: msg.nextState,
            senderRole: msg.senderRole,
            createdAt: msg.createdAt,
            status: msg.status || 'sent',
            fromMe: msg.sender?.toString() === userIdStr
          }));

          console.log('📤 Sending messages with IDs:',
            messages.map(m => ({ id: m._id, status: m.status }))
          );
        }
      }

      const onlineStatuses = {};
      for (const participant of chatRoom.participants) {
        const participantId = participant._id.toString();
        onlineStatuses[participantId] = onlineUsers.has(participantId);
      }

      socket.emit('initialData', {
        messages,
        currentState,
        userRole,
        conversationMode,
        roomInfo: {
          propertyTitle: chatRoom.name,
          participants: chatRoom.participants
        },
        onlineStatuses,
        ownerPhone: ''
      });

      if (chatRoom.productId) {
        Room.findById(chatRoom.productId)
          .select('contactPhone')
          .lean()
          .then(property => {
            if (property?.contactPhone) {
              // console.log(`📞 Sending owner phone: ${property.contactPhone}`);
              socket.emit('ownerPhoneUpdate', { ownerPhone: property.contactPhone });
            }
          })
          .catch(err => console.error('❌ Phone fetch error:', err));
      }

      socket.to(roomIdStr).emit('userJoinedRoom', {
        userId: userIdStr,
        userInfo: chatRoom.participants.find(p => p._id.toString() === userIdStr),
        timestamp: new Date()
      });

      setTimeout(() => {
        broadcastOnlineStatus(roomIdStr, socket.id);
      }, 100);

      // console.log(`📢 User ${userIdStr} joined room ${roomIdStr}`);

    } catch (error) {
      console.error('❌ Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room', error: error.message });
    }
  });

  // ✅ SIMPLE SENDMESSAGE - NO AUTO-DELIVERY
  socket.on('sendMessage', async ({
    roomId,
    sender,
    optionId,
    optionText,
    text,
    messageType = 'option',
    nextState,
    senderRole,
    tempId
  }) => {
    console.log(`📤 SEND MESSAGE (${messageType}):`, {
      room: roomId,
      sender,
      type: messageType,
      content: messageType === 'freetext' ? text : optionText,
      tempId
    });

    try {
      if (!roomId || !sender || !senderRole) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      // Rate limiting check
      const now = Date.now();
      const userMessages = userMessageCounts.get(sender.toString()) || [];
      const recentMessages = userMessages.filter(time => now - time < 60000);

      if (recentMessages.length >= MESSAGE_RATE_LIMIT) {
        socket.emit('error', { message: 'Message rate limit exceeded. Please wait a moment.' });
        return;
      }

      // Validation
      if (messageType === 'option' && (!optionId || !optionText)) {
        socket.emit('error', { message: 'Option messages require optionId and optionText' });
        return;
      }

      if (messageType === 'freetext') {
        if (!text) {
          socket.emit('error', { message: 'Freetext messages require text' });
          return;
        }
        if (text.length > 500) {
          socket.emit('error', { message: 'Message too long (max 500 characters)' });
          return;
        }
        if (text.trim().length === 0) {
          socket.emit('error', { message: 'Message cannot be empty' });
          return;
        }
      }

      const senderUser = await User.findById(sender).select('name picture');

      const room = await ChatRoom.findById(roomId).populate('participants', '_id name expoPushToken notificationSettings');
      if (room) {
        const updateData = {
          lastMessage: messageType === 'freetext' ? text : optionText,
          lastMessageSender: sender,
          lastMessageAt: new Date(),
          updatedAt: new Date()
        };

        updateData.readBy = [sender];

        if (room.status === 'pending' && !room.hasMessages) {
          updateData.status = 'active';
          updateData.hasMessages = true;
          updateData.firstMessageAt = new Date();
        }

        await ChatRoom.findByIdAndUpdate(roomId, updateData);
      }

      let chat = await Chat.findOne({ roomId });
      if (!chat) {
        chat = new Chat({
          roomId,
          messages: [],
          conversationMode: 'hybrid',
          currentState: nextState || 'START'
        });
      }

      const newMessage = {
        sender,
        messageType,
        senderRole,
        createdAt: new Date(),
        status: 'sent' // ✅ ALWAYS START AS SENT
      };

      if (messageType === 'option') {
        newMessage.optionId = optionId;
        newMessage.option = optionText;
        newMessage.nextState = nextState;
      } else if (messageType === 'freetext') {
        newMessage.text = text;
        newMessage.nextState = chat.currentState;
      }

      chat.messages.push(newMessage);

      if (nextState && messageType === 'option') {
        chat.currentState = nextState;
      }

      await chat.save();

      recentMessages.push(now);
      userMessageCounts.set(sender.toString(), recentMessages);

      const savedMessage = chat.messages[chat.messages.length - 1];

      const broadcastData = {
        message: {
          _id: savedMessage._id.toString(),
          sender: savedMessage.sender,
          optionId: savedMessage.optionId,
          option: savedMessage.option,
          text: savedMessage.text,
          messageType: savedMessage.messageType,
          nextState: savedMessage.nextState,
          senderRole: savedMessage.senderRole,
          createdAt: savedMessage.createdAt,
          status: 'sent' // ✅ ALWAYS SENT
        },
        nextState: messageType === 'option' ? nextState : chat.currentState,
        tempId
      };

      // ✅ Broadcast to all in room
      io.in(roomId).emit('newMessage', broadcastData);

      // ❌ NO AUTO-DELIVERY LOGIC - REMOVED COMPLETELY

      await notifyParticipantsOfChatUpdate(roomId, sender);

      // Background processing
      setImmediate(async () => {
        try {
          const updatedRoom = await ChatRoom.findById(roomId).populate('participants');
          if (updatedRoom) {
            const participantsUnreadStatus = {};

            updatedRoom.participants.forEach(participant => {
              const isUnread = updatedRoom.lastMessageSender &&
                updatedRoom.lastMessageSender.toString() !== participant._id.toString() &&
                !updatedRoom.readBy.includes(participant._id);
              participantsUnreadStatus[participant._id.toString()] = isUnread;
            });

            io.in(roomId).emit('unreadStatusUpdate', {
              roomId: roomId,
              hasUnread: participantsUnreadStatus,
              lastMessage: updatedRoom.lastMessage,
              lastMessageAt: updatedRoom.lastMessageAt
            });

            updatedRoom.participants.forEach(async (participant) => {
              const userRooms = await ChatRoom.find({
                participants: participant._id,
                status: 'active',
                hasMessages: true
              });

              const unreadCount = userRooms.filter(room =>
                room.lastMessageSender &&
                room.lastMessageSender.toString() !== participant._id.toString() &&
                !room.readBy.includes(participant._id)
              ).length;

              io.to(`user_${participant._id.toString()}`).emit('globalUnreadUpdate', {
                hasUnread: unreadCount > 0,
                unreadCount: unreadCount
              });
            });
          }

          // Push notifications
          if (room && room.participants) {
            for (const participant of room.participants) {
              if (participant._id.toString() === sender.toString()) continue;

              const recipientSocketId = onlineUsers.get(participant._id.toString());
              const isRecipientInRoom = recipientSocketId && io.sockets.adapter.rooms.get(roomId)?.has(recipientSocketId);

              if (!isRecipientInRoom && participant.expoPushToken) {
                const notifEnabled = participant.notificationSettings?.enabled !== false;
                const chatNotifEnabled = participant.notificationSettings?.chatMessages !== false;

                if (notifEnabled && chatNotifEnabled) {
                  try {
                    const messageContent = messageType === 'freetext' ? text : optionText;

                    await sendPushNotification(participant.expoPushToken, {
                      senderName: senderUser ? `${senderUser.name}` : 'New Message',
                      message: messageContent.length > 100
                        ? messageContent.substring(0, 100) + '...'
                        : messageContent,
                      senderAvatar: senderUser?.picture,
                      chatId: roomId.toString(),
                      userId: sender.toString(),
                      badge: 1,
                      additionalData: {
                        type: 'chat_message',
                        roomId: roomId.toString(),
                        senderId: sender.toString(),
                        senderName: senderUser?.name || 'Unknown User',
                        screen: 'ChatScreen',
                        productTitle: room.name,
                        messageType: messageType
                      }
                    });
                  } catch (pushError) {
                    console.error('❌ Push notification failed:', pushError);
                  }
                }
              }
            }
          }
        } catch (asyncError) {
          console.error('❌ Error in async post-message processing:', asyncError);
        }
      });

    } catch (error) {
      console.error('❌ Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message', error: error.message });
    }
  });

  // ❌ messageDelivered HANDLER REMOVED - NOT NEEDED

  // ✅ MARK AS SEEN (replaces markAsRead)
  socket.on('markAsRead', async (data) => {
    try {
      // console.log('👁️ markAsSeen received:', data);

      let roomId, userId;

      if (typeof data === 'string') {
        roomId = data;
        userId = socket.userId;
      } else if (typeof data === 'object') {
        roomId = data.roomId;
        userId = data.userId;
      }

      if (!roomId || !userId) {
        // console.log('❌ markAsSeen: Missing roomId or userId');
        return;
      }

      const room = await ChatRoom.findById(roomId);
      if (!room) return;

      // Update room read status
      if (!room.readBy.includes(userId)) {
        room.readBy.push(userId);
        await room.save();
      }

      const chat = await Chat.findOne({ roomId });
      if (chat) {
        let updatedMessageIds = [];

        // ✅ Mark OTHER user's messages as SEEN
        chat.messages.forEach(msg => {
          const isOtherUserMessage = msg.sender.toString() !== userId;
          const isSent = msg.status === 'sent'; // Only mark 'sent' → 'seen'

          if (isOtherUserMessage && isSent) {
            msg.status = 'seen'; // ✅ Change to SEEN
            updatedMessageIds.push(msg._id.toString());
          }
        });

        if (updatedMessageIds.length > 0) {
          await chat.save();

          // ✅ Broadcast to ALL participants
          io.to(roomId).emit('messagesMarkedAsSeen', {
            roomId,
            messageIds: updatedMessageIds,
            seenBy: userId,
            timestamp: new Date()
          });

          // console.log(`✅ Marked ${updatedMessageIds.length} messages as SEEN by ${userId}`);
        }
      }

    } catch (error) {
      console.error('❌ Error marking as seen:', error);
    }
  });

  socket.on('getOnlineStatus', async ({ roomId, userId }) => {
    try {
      if (!roomId || !userId) {
        console.warn('⚠️ getOnlineStatus: Missing roomId or userId');
        return;
      }

      const roomIdStr = roomId.toString();
      const userIdStr = userId.toString();

      const room = await ChatRoom.findById(roomIdStr).populate('participants', '_id');
      if (!room) {
        console.warn(`⚠️ Room ${roomIdStr} not found`);
        return;
      }

      const onlineStatuses = {};
      for (const participant of room.participants) {
        const participantId = participant._id.toString();
        onlineStatuses[participantId] = onlineUsers.has(participantId);
      }

      // console.log(`📊 Sending online statuses for room ${roomIdStr}:`, onlineStatuses);
      socket.emit('onlineStatuses', { roomId: roomIdStr, statuses: onlineStatuses });
    } catch (error) {
      console.error('❌ Error getting online status:', error);
      socket.emit('error', { message: 'Failed to get online status' });
    }
  });

  socket.on('deleteMessage', async ({ roomId, messageIdentifier, userId }) => {
    console.log('🗑️ DELETE MESSAGE REQUEST WITH IDENTIFIER:', {
      roomId: roomId?.toString(),
      messageIdentifier,
      userId: userId?.toString()
    });

    try {
      if (!roomId || !messageIdentifier || !userId) {
        // console.log('❌ Missing fields:', { roomId, messageIdentifier, userId });
        socket.emit('error', { message: 'Missing required fields for deletion' });
        return;
      }

      const chat = await Chat.findOne({ roomId });
      if (!chat) {
        socket.emit('error', { message: 'Chat not found' });
        return;
      }

      const targetDate = new Date(messageIdentifier.createdAt);

      const messageIndex = chat.messages.findIndex(msg => {
        const senderMatch = msg.sender?.toString() === messageIdentifier.sender?.toString();
        const msgDate = msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
        const dateMatch = Math.abs(targetDate.getTime() - msgDate.getTime()) < 1000;
        const typeMatch = msg.messageType === messageIdentifier.messageType;
        const textMatch = msg.messageType === 'freetext'
          ? msg.text === messageIdentifier.text
          : msg.option === messageIdentifier.text;

        return senderMatch && dateMatch && typeMatch && textMatch;
      });

      if (messageIndex === -1) {
        // console.log('❌ Message not found');
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      const message = chat.messages[messageIndex];

      if (message.sender.toString() !== userId.toString()) {
        socket.emit('error', { message: 'Unauthorized: You can only delete your own messages' });
        return;
      }

      const deletedMessageId = message._id?.toString() || messageIdentifier.createdAt;

      chat.messages.pull(message._id);
      await chat.save();

      // console.log(`✅ Message deleted successfully. Index: ${messageIndex}`);

      const room = await ChatRoom.findById(roomId);
      if (room) {
        const lastMessage = chat.messages[chat.messages.length - 1];
        if (lastMessage) {
          const updateData = {
            lastMessage: lastMessage.messageType === 'freetext'
              ? lastMessage.text
              : lastMessage.option,
            updatedAt: new Date()
          };
          await ChatRoom.findByIdAndUpdate(roomId, updateData);
        } else {
          await ChatRoom.findByIdAndUpdate(roomId, {
            lastMessage: null,
            updatedAt: new Date()
          });
        }
      }

      io.in(roomId).emit('messageDeleted', {
        messageId: deletedMessageId,
        roomId,
        deletedBy: userId,
        timestamp: new Date()
      });

      await notifyParticipantsOfChatUpdate(roomId);

    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('error', {
        message: 'Failed to delete message',
        error: error.message
      });
    }
  });

  socket.on('messageStatus', async ({ roomId, messageId, status }) => {
    try {
      const chat = await Chat.findOne({ roomId });
      if (chat) {
        const message = chat.messages.id(messageId);
        if (message) {
          message.status = status;
          await chat.save();

          socket.to(roomId).emit('messageStatusUpdate', {
            messageId,
            status,
            updatedAt: new Date()
          });
        }
      }
    } catch (error) {
      console.error('❌ Error updating message status:', error);
    }
  });

  socket.on('typing', ({ roomId, userId, isTyping }) => {
    socket.to(roomId).emit('userTyping', { userId, isTyping });
  });

  socket.on('leaveRoom', ({ roomId, userId }) => {
    if (userId) {
      const userIdStr = userId.toString();
      const roomIdStr = roomId.toString();

      if (userRooms.has(userIdStr)) {
        userRooms.get(userIdStr).delete(roomIdStr);
        if (userRooms.get(userIdStr).size === 0) {
          userRooms.delete(userIdStr);
        }
      }

      setTimeout(() => {
        broadcastOnlineStatus(roomIdStr);
      }, 100);
    }

    socket.leave(roomId);
  });

  socket.on('disconnect', (reason) => {
    // console.log(`❌ User disconnected: ${socket.id}, Reason: ${reason}`);

    const disconnectedUserId = userSockets.get(socket.id);

    if (disconnectedUserId) {
      onlineUsers.delete(disconnectedUserId);
      userSockets.delete(socket.id);

      if (userRooms.has(disconnectedUserId)) {
        const rooms = userRooms.get(disconnectedUserId);
        rooms.forEach(roomId => {
          setTimeout(() => {
            broadcastOnlineStatus(roomId);
          }, 100);
        });
        userRooms.delete(disconnectedUserId);
      }
    }
  });
});

// Debug endpoints
app.get("/api/debug/connections", (req, res) => {
  const connections = [];
  io.sockets.sockets.forEach(socket => {
    connections.push({
      id: socket.id,
      connected: socket.connected,
      rooms: Array.from(socket.rooms)
    });
  });

  res.json({
    totalConnections: io.engine.clientsCount,
    onlineUsers: Array.from(onlineUsers.entries()),
    userRooms: Array.from(userRooms.entries()).map(([userId, rooms]) => ({
      userId,
      rooms: Array.from(rooms)
    })),
    connections,
    rateLimits: Array.from(userMessageCounts.entries()).map(([userId, times]) => ({
      userId,
      messageCount: times.length,
      lastMinute: times.filter(time => Date.now() - time < 60000).length
    }))
  });
});

app.get("/api/debug/rooms", (req, res) => {
  const rooms = {};
  io.sockets.adapter.rooms.forEach((sockets, roomId) => {
    rooms[roomId] = {
      sockets: Array.from(sockets),
      users: Array.from(sockets).map(socketId => userSockets.get(socketId)).filter(Boolean)
    };
  });

  res.json({
    totalRooms: Object.keys(rooms).length,
    rooms
  });
});

app.get("/api/debug/presence", (req, res) => {
  const presenceData = {
    onlineUsers: Array.from(onlineUsers.entries()),
    userRooms: Array.from(userRooms.entries()).map(([userId, rooms]) => ({
      userId,
      rooms: Array.from(rooms)
    })),
    userSockets: Array.from(userSockets.entries()),
    totalOnline: onlineUsers.size,
    totalTrackedUsers: userRooms.size
  };

  res.json(presenceData);
});

app.get("/api/debug/online-users", (req, res) => {
  res.json({
    onlineUsers: Array.from(onlineUsers.entries()),
    totalOnline: onlineUsers.size,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    connections: io.engine.clientsCount,
    onlineUsers: onlineUsers.size,
    rateLimitedUsers: userMessageCounts.size,
    mode: 'simple-sent-seen-system'
  });
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📡 Socket.IO ready with SIMPLE SENT/SEEN SYSTEM`);
  console.log(`🛡️  Rate limiting: ${MESSAGE_RATE_LIMIT} messages/minute`);
});