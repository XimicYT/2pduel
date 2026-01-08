const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Enable CORS
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// GAME STATE
const rooms = {};
let queue = [];
const disconnectTimers = {}; // Stores the "Bleed Out" intervals

io.on('connection', (socket) => {
    console.log(`[CONNECT] New Socket: ${socket.id}`);

    // ==========================================
    // 1. RECONNECTION HANDLER
    // ==========================================
    socket.on('reconnectRequest', ({ roomID, oldSocketID }) => {
        console.log(`[RECONNECT] Attempt: ${oldSocketID} -> ${socket.id} (Room: ${roomID})`);
        
        const room = rooms[roomID];
        
        // Validation: Room must exist, and Old Player data must still be there
        if (room && room.players[oldSocketID]) {
            console.log(`[RECONNECT] SUCCESS! Restoring state.`);
            
            // A. Stop the Bleeding
            if (disconnectTimers[oldSocketID]) {
                clearInterval(disconnectTimers[oldSocketID]);
                delete disconnectTimers[oldSocketID];
                console.log(`[TIMER] Bleed timer cancelled for ${oldSocketID}`);
            }

            // B. Swap Data to New Socket
            room.players[socket.id] = room.players[oldSocketID];
            room.players[socket.id].id = socket.id; // Update internal ID
            delete room.players[oldSocketID];       // Remove old key

            // C. Re-join Socket.io Room
            socket.join(roomID);
            
            // D. Restore State to Returning Player
            socket.emit('reconnectSuccess', { 
                roomID, 
                players: room.players,
                me: room.players[socket.id] 
            });

            // E. Sync Both Players & Start Countdown
            io.to(roomID).emit('playerReconnected', { 
                id: socket.id, 
                oldId: oldSocketID,
                resumeIn: 3 // Seconds to wait
            });

        } else {
            console.log(`[RECONNECT] FAILED. Room or player not found.`);
            socket.emit('reconnectFailed');
        }
    });

    // ==========================================
    // 2. MATCHMAKING
    // ==========================================
    socket.on('joinQueue', (playerData) => {
        // Remove from queue if already there
        queue = queue.filter(p => p.id !== socket.id);
        
        console.log(`[QUEUE] User ${playerData.username} joined.`);
        queue.push({ id: socket.id, data: playerData });

        if (queue.length >= 2) {
            const p1 = queue.shift();
            const p2 = queue.shift();
            const roomID = `room_${Date.now()}`;
            
            console.log(`[MATCH] Creating Room ${roomID}`);

            rooms[roomID] = {
                id: roomID,
                players: {
                    [p1.id]: { 
                        id: p1.id, 
                        username: p1.data.username,
                        classType: p1.data.classType,
                        hp: 100, maxHp: 100, 
                        x: 100, y: 300, 
                        angle: 0,
                        ...p1.data 
                    },
                    [p2.id]: { 
                        id: p2.id, 
                        username: p2.data.username,
                        classType: p2.data.classType,
                        hp: 100, maxHp: 100,
                        x: 1800, y: 300, 
                        angle: Math.PI, // Facing left
                        ...p2.data 
                    }
                }
            };

            // Join Rooms
            const s1 = io.sockets.sockets.get(p1.id);
            const s2 = io.sockets.sockets.get(p2.id);
            if(s1) s1.join(roomID);
            if(s2) s2.join(roomID);

            // Notify Players
            io.to(p1.id).emit('matchFound', { roomID, players: rooms[roomID].players });
            io.to(p2.id).emit('matchFound', { roomID, players: rooms[roomID].players });
        }
    });

    // ==========================================
    // 3. GAMEPLAY
    // ==========================================
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const p = rooms[data.roomID].players[socket.id];
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            socket.to(data.roomID).emit('opponentUpdate', p);
        }
    });

    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });

    // ==========================================
    // 4. DISCONNECT HANDLER
    // ==========================================
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] Socket: ${socket.id}`);
        
        // Find the Room they were in
        let targetRoomId = null;
        for (const rId in rooms) {
            if (rooms[rId].players[socket.id]) {
                targetRoomId = rId;
                break;
            }
        }

        if (targetRoomId) {
            const room = rooms[targetRoomId];
            console.log(`[GAME] Player left active match in ${targetRoomId}`);

            // Notify opponent immediately
            io.to(targetRoomId).emit('opponentDisconnected', { id: socket.id });

            // START BLEED OUT TIMER
            const playerState = room.players[socket.id];
            const damagePerTick = Math.ceil((playerState.maxHp || 100) * 0.05); // 5% per second

            disconnectTimers[socket.id] = setInterval(() => {
                // Safety check: ensure room still exists
                if (!rooms[targetRoomId] || !rooms[targetRoomId].players[socket.id]) {
                    clearInterval(disconnectTimers[socket.id]);
                    return;
                }

                playerState.hp -= damagePerTick;
                console.log(`[BLEED] ${socket.id} HP: ${playerState.hp}`);

                // Send HP Update
                io.to(targetRoomId).emit('playerDamage', { 
                    id: socket.id, 
                    hp: playerState.hp 
                });

                // Check Death
                if (playerState.hp <= 0) {
                    clearInterval(disconnectTimers[socket.id]);
                    delete disconnectTimers[socket.id];
                    console.log(`[GAME OVER] Player bled out.`);
                    
                    io.to(targetRoomId).emit('gameOver', { winner: 'opponent_disconnect' });
                    delete rooms[targetRoomId];
                }
            }, 1000); 

        } else {
            // Just remove from queue
            queue = queue.filter(p => p.id !== socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
