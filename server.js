const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1. SETUP SERVER
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// 2. GAME CONSTANTS & STATE
const TICK_RATE = 1000 / 60; // 60 FPS Server Loop
const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;

// Combat Stats
const MAX_HP = 100;
const BLEED_DAMAGE = 5; // Per second (disconnect)
const BULLET_SPEED = 18;
const BULLET_RADIUS = 6;
const PLAYER_RADIUS = 30;
const BULLET_DAMAGE = 10;

let rooms = {}; 
let waitingPlayer = null; 
let disconnectTimers = {}; 

// 3. HELPER FUNCTIONS

// Distance formula
function getDistance(a, b) {
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

// 4. SOCKET LOGIC
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- MATCHMAKING ---
    socket.on('joinQueue', (playerData) => {
        const cleanName = (playerData.username || "Agent").substring(0, 12).replace(/[^a-zA-Z0-9 _-]/g, "");
        playerData.username = cleanName;

        // Uniqueness Check
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
            }
        }

        if (nameTaken) {
            socket.emit('queueError', 'NAME ALREADY IN USE. CHOOSE ANOTHER.');
            return;
        }

        if (waitingPlayer) {
            // Create Match
            const roomID = `room_${Date.now()}`;
            const p1ID = waitingPlayer.id;
            const p2ID = socket.id;

            rooms[roomID] = {
                id: roomID,
                // Initialize Combat Arrays
                bullets: [],
                objects: [], // Placeholder for future obstacles
                players: {
                    [p1ID]: { 
                        ...waitingPlayer.data, 
                        hp: MAX_HP, 
                        maxHp: MAX_HP, 
                        x: 100, 
                        y: 540, 
                        angle: 0 
                    },
                    [p2ID]: { 
                        ...playerData, 
                        hp: MAX_HP, 
                        maxHp: MAX_HP, 
                        x: 1820, 
                        y: 540, 
                        angle: Math.PI 
                    }
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

    // --- PLAYER MOVEMENT ---
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const player = rooms[data.roomID].players[socket.id];
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;
            
            // Relay to opponent (Client prediction is smoother for movement)
            socket.to(data.roomID).emit('opponentUpdate', { 
                id: socket.id, 
                x: data.x, 
                y: data.y, 
                angle: data.angle 
            });
        }
    });

    // --- PLAYER SHOOTING (New) ---
    socket.on('playerShoot', (data) => {
        const room = rooms[data.roomID];
        if (room && room.players[socket.id]) {
            const player = room.players[socket.id];

            // Calculate spawn position (tip of the gun)
            // Offset slightly so you don't shoot yourself
            const spawnDist = PLAYER_RADIUS + 10;
            const bx = player.x + Math.cos(data.angle) * spawnDist;
            const by = player.y + Math.sin(data.angle) * spawnDist;

            // Add bullet to Server State
            room.bullets.push({
                id: `b_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: bx,
                y: by,
                angle: data.angle,
                speed: BULLET_SPEED,
                damage: BULLET_DAMAGE
            });
        }
    });

    // --- ABANDON MATCH ---
    socket.on('abandonMatch', () => {
        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) {
                targetRoomId = rID;
                break;
            }
        }

        if (targetRoomId) {
            // Stop bleeding timers
            Object.keys(disconnectTimers).forEach(id => {
                if (rooms[targetRoomId].players[id]) {
                    clearInterval(disconnectTimers[id]);
                    delete disconnectTimers[id];
                }
            });

            io.to(targetRoomId).emit('gameOver', { winner: 'draw' });
            delete rooms[targetRoomId];
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

            // START BLEED OUT TIMER
            disconnectTimers[socket.id] = setInterval(() => {
                if (!rooms[targetRoomId]) {
                    clearInterval(disconnectTimers[socket.id]);
                    delete disconnectTimers[socket.id];
                    return;
                }

                const player = rooms[targetRoomId].players[socket.id];
                if (player) {
                    player.hp -= BLEED_DAMAGE;
                    // Emit damage update
                    io.to(targetRoomId).emit('playerDamage', { id: socket.id, hp: player.hp });

                    if (player.hp <= 0) {
                        endGame(targetRoomId, "opponent_disconnect", socket.id);
                    }
                } else {
                    clearInterval(disconnectTimers[socket.id]);
                }
            }, 1000);
        }
    });
    
    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

// 5. SERVER GAME LOOP (The Combat Engine)
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(rooms[roomId]);
    }
}, TICK_RATE);

function updateRoom(room) {
    if (!room.bullets || room.bullets.length === 0) return;

    // A list of bullet IDs to remove
    let bulletsToRemove = [];
    let stateChanged = false;

    // 1. Move Bullets
    room.bullets.forEach(b => {
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;

        // Check Boundaries
        if (b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) {
            bulletsToRemove.push(b.id);
        }

        // Check Collisions
        for (const playerId in room.players) {
            // Don't hit yourself
            if (playerId === b.ownerId) continue;

            const player = room.players[playerId];
            const dist = getDistance(b, player);

            if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
                // HIT CONFIRMED
                player.hp -= b.damage;
                bulletsToRemove.push(b.id);
                stateChanged = true;

                // Notify clients of damage
                io.to(room.id).emit('playerDamage', { id: playerId, hp: player.hp });

                // Check Death
                if (player.hp <= 0) {
                    // The winner is the owner of the bullet
                    endGame(room.id, "kill", b.ownerId); 
                    return; // Stop updating this room, it's over
                }
            }
        }
    });

    // 2. Cleanup Bullets
    if (bulletsToRemove.length > 0) {
        room.bullets = room.bullets.filter(b => !bulletsToRemove.includes(b.id));
        stateChanged = true;
    }

    // 3. Sync Projectiles to Clients
    // We send this every tick (60hz) or whenever it changes. 
    // For smooth bullets, clients need regular updates.
    if (stateChanged || room.bullets.length > 0) {
        io.to(room.id).emit('projectilesUpdate', room.bullets);
    }
}

// Helper to end game cleanly
function endGame(roomId, reason, winnerOrLoserId) {
    // Stop all bleed timers for this room
    if (rooms[roomId]) {
        Object.keys(rooms[roomId].players).forEach(pid => {
            if (disconnectTimers[pid]) {
                clearInterval(disconnectTimers[pid]);
                delete disconnectTimers[pid];
            }
        });

        // Determine winner
        let winnerId = null;
        if (reason === "kill") {
            winnerId = winnerOrLoserId; // The killer won
        } else if (reason === "opponent_disconnect") {
            // The loser is passed in, find the other guy
            winnerId = Object.keys(rooms[roomId].players).find(id => id !== winnerOrLoserId);
        }

        io.to(roomId).emit('gameOver', { winner: reason, winnerId: winnerId });
        console.log(`Game Over in ${roomId}. Reason: ${reason}`);
        delete rooms[roomId];
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
