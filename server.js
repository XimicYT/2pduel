const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

let rooms = {}; 
let waitingPlayer = null; 
let disconnectTimers = {}; 

const MAX_HP = 100;
const BLEED_DAMAGE = 5; 

io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- MATCHMAKING ---
    socket.on('joinQueue', (playerData) => {
        const cleanName = (playerData.username || "Agent").substring(0, 12).replace(/[^a-zA-Z0-9 _-]/g, "");
        playerData.username = cleanName;

        let nameTaken = false;
        if (waitingPlayer && waitingPlayer.data.username === cleanName) nameTaken = true;
        if (!nameTaken) {
            for (const rID in rooms) {
                const players = rooms[rID].players;
                for (const pID in players) {
                    if (players[pID].username === cleanName) {
                        nameTaken = true;
                        break;
                    }
                }
                if (nameTaken) break;
            }
        }

        if (nameTaken) {
            socket.emit('queueError', 'NAME ALREADY IN USE. CHOOSE ANOTHER.');
            return;
        }

        if (waitingPlayer) {
            const roomID = `room_${Date.now()}`;
            const p1ID = waitingPlayer.id;
            const p2ID = socket.id;

            rooms[roomID] = {
                id: roomID,
                players: {
                    [p1ID]: { ...waitingPlayer.data, hp: MAX_HP, maxHp: MAX_HP, x: 100, y: 540, angle: 0 },
                    [p2ID]: { ...playerData, hp: MAX_HP, maxHp: MAX_HP, x: 1820, y: 540, angle: Math.PI }
                }
            };

            waitingPlayer.socket.join(roomID);
            socket.join(roomID);

            io.to(roomID).emit('matchFound', { roomID, players: rooms[roomID].players });
            waitingPlayer = null; 
        } else {
            waitingPlayer = { id: socket.id, socket: socket, data: playerData };
        }
    });

    // --- MOVEMENT ---
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const player = rooms[data.roomID].players[socket.id];
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;
            socket.to(data.roomID).emit('opponentUpdate', { id: socket.id, x: data.x, y: data.y, angle: data.angle });
        }
    });

    // --- RECONNECT ---
    socket.on('reconnectRequest', (data) => {
        const { roomID, oldSocketID } = data;
        if (rooms[roomID] && rooms[roomID].players[oldSocketID]) {
            if (disconnectTimers[oldSocketID]) {
                clearInterval(disconnectTimers[oldSocketID]);
                delete disconnectTimers[oldSocketID];
            }

            const pData = rooms[roomID].players[oldSocketID];
            delete rooms[roomID].players[oldSocketID];
            rooms[roomID].players[socket.id] = pData;

            socket.join(roomID);
            socket.emit('reconnectSuccess', { roomID, me: pData, players: rooms[roomID].players });
            socket.to(roomID).emit('playerReconnected', { oldId: oldSocketID, id: socket.id, resumeIn: 3 });
        } else {
            socket.emit('reconnectFailed');
        }
    });

    // --- ABANDON MATCH (New) ---
    socket.on('abandonMatch', () => {
        // Find the room this player is in
        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) {
                targetRoomId = rID;
                break;
            }
        }

        if (targetRoomId) {
            // Stop any active timers for this room (in case both abandoned?)
            Object.keys(disconnectTimers).forEach(id => {
                if (rooms[targetRoomId].players[id]) {
                    clearInterval(disconnectTimers[id]);
                    delete disconnectTimers[id];
                }
            });

            // Declare Draw
            io.to(targetRoomId).emit('gameOver', { winner: 'draw' });
            
            // Delete Room
            delete rooms[targetRoomId];
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
            return;
        }

        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) {
                targetRoomId = rID;
                break;
            }
        }

        if (targetRoomId) {
            io.to(targetRoomId).emit('opponentDisconnected', { id: socket.id });

            disconnectTimers[socket.id] = setInterval(() => {
                if (!rooms[targetRoomId]) {
                    clearInterval(disconnectTimers[socket.id]);
                    delete disconnectTimers[socket.id];
                    return;
                }

                const player = rooms[targetRoomId].players[socket.id];
                if (player) {
                    player.hp -= BLEED_DAMAGE;
                    io.to(targetRoomId).emit('playerDamage', { id: socket.id, hp: player.hp });

                    if (player.hp <= 0) {
                        clearInterval(disconnectTimers[socket.id]);
                        delete disconnectTimers[socket.id];
                        const winnerId = Object.keys(rooms[targetRoomId].players).find(id => id !== socket.id);
                        io.to(targetRoomId).emit('gameOver', { winner: "opponent_disconnect", winnerId });
                        delete rooms[targetRoomId];
                    }
                } else {
                    clearInterval(disconnectTimers[socket.id]);
                }
            }, 1000);
        }
    });
    
    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
