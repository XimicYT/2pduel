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

// 2. GAME CONSTANTS
const TICK_RATE = 1000 / 60; // 60 FPS Server Loop
const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const MAX_HP = 100;
const BLEED_DAMAGE = 5; // Damage per second when disconnected
const PLAYER_RADIUS = 30;

// 3. WEAPON DATABASE
// These keys match the value="" in your HTML select menus exactly.
const WEAPONS = {
    // --- PRIMARY ---
    'pulse':   { damage: 12, speed: 22, cooldown: 150,  range: 1100, color: '#00f3ff' }, // Standard Rifle
    'rail':    { damage: 45, speed: 45, cooldown: 1300, range: 3000, color: '#ff0055' }, // Sniper
    'scatter': { damage: 8,  speed: 20, cooldown: 850,  range: 500,  color: '#ffff00', count: 6, spread: 0.35 }, // Shotgun
    'void':    { damage: 60, speed: 14, cooldown: 2000, range: 900,  color: '#9900ff' }, // Rocket-like
    'twin':    { damage: 9,  speed: 26, cooldown: 70,   range: 750,  color: '#00ffaa' }, // Rapid SMG

    // --- SECONDARY ---
    'pistol':  { damage: 12, speed: 18, cooldown: 300,  range: 800,  color: '#cccccc' },
    'mag':     { damage: 28, speed: 25, cooldown: 600,  range: 1000, color: '#ffaa00' }, // Heavy Pistol
    'knife':   { damage: 50, speed: 30, cooldown: 500,  range: 150,  color: '#ffffff' }, // Melee
    'mine':    { damage: 80, speed: 2,  cooldown: 3000, range: 400,  color: '#ff0000' }, // Slow Trap

    // --- UTILITY ---
    // Mapped to projectiles for now to prevent crashes.
    'repulse': { damage: 10, speed: 15, cooldown: 4000, range: 350,  color: '#ffffff', count: 12, spread: 6.28 }, // 360 wave
    'dash':    { damage: 0,  speed: 0,  cooldown: 1000, range: 0,    color: 'transparent' }, // Placeholder
    'shield':  { damage: 0,  speed: 0,  cooldown: 1000, range: 0,    color: 'transparent' }, // Placeholder
    'cloak':   { damage: 0,  speed: 0,  cooldown: 1000, range: 0,    color: 'transparent' }, // Placeholder
    
    // Fallbacks (Legacy)
    'rifle':   { damage: 12, speed: 20, cooldown: 150,  range: 1000, color: '#ffff00' },
    'grenade': { damage: 60, speed: 10, cooldown: 3000, range: 600,  color: '#00ff00' }
};

// 4. STATE MANAGEMENT
let rooms = {}; 
let waitingPlayer = null; 
let disconnectTimers = {}; 

// Helper: Distance Formula
function getDistance(a, b) {
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

// 5. SOCKET LOGIC
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- MATCHMAKING ---
    socket.on('joinQueue', (playerData) => {
        const cleanName = (playerData.username || "Agent").substring(0, 12).replace(/[^a-zA-Z0-9 _-]/g, "");
        
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
                if (nameTaken) break;
            }
        }

        if (nameTaken) {
            socket.emit('queueError', 'NAME ALREADY IN USE. CHOOSE ANOTHER.');
            return;
        }

        // Prepare Player Object with Loadout
        // CRITICAL FIX: Ensure we use the keys sent by HTML, or fallback safely
        const finalPlayerData = {
            username: cleanName,
            classType: playerData.classType || 'assault',
            primary:   WEAPONS[playerData.primary]   ? playerData.primary   : 'pulse',
            secondary: WEAPONS[playerData.secondary] ? playerData.secondary : 'pistol',
            utility:   WEAPONS[playerData.utility]   ? playerData.utility   : 'repulse'
        };

        console.log(`Player ${cleanName} joined. Loadout: ${finalPlayerData.primary}, ${finalPlayerData.secondary}, ${finalPlayerData.utility}`);

        if (waitingPlayer) {
            // Create Match
            const roomID = `room_${Date.now()}`;
            const p1ID = waitingPlayer.id;
            const p2ID = socket.id;

            rooms[roomID] = {
                id: roomID,
                bullets: [],
                players: {
                    [p1ID]: { 
                        ...waitingPlayer.data, 
                        hp: MAX_HP, maxHp: MAX_HP, 
                        x: 100, y: 540, angle: 0,
                        lastShootTime: 0 
                    },
                    [p2ID]: { 
                        ...finalPlayerData, 
                        hp: MAX_HP, maxHp: MAX_HP, 
                        x: 1820, y: 540, angle: Math.PI,
                        lastShootTime: 0
                    }
                }
            };

            waitingPlayer.socket.join(roomID);
            socket.join(roomID);

            io.to(roomID).emit('matchFound', { roomID, players: rooms[roomID].players });
            waitingPlayer = null; 
        } else {
            waitingPlayer = { id: socket.id, socket: socket, data: finalPlayerData };
        }
    });

    // --- MOVEMENT ---
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const player = rooms[data.roomID].players[socket.id];
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;
            
            // Relay to opponent
            socket.to(data.roomID).emit('opponentUpdate', { 
                id: socket.id, 
                x: data.x, 
                y: data.y, 
                angle: data.angle 
            });
        }
    });

    // --- SHOOTING ---
    socket.on('playerShoot', (data) => {
        const room = rooms[data.roomID];
        if (!room || !room.players[socket.id]) return;

        const player = room.players[socket.id];
        const weaponKey = player[data.slot]; 
        const stats = WEAPONS[weaponKey];

        if (!stats) return;

        const now = Date.now();
        if (now - player.lastShootTime < stats.cooldown) return;
        player.lastShootTime = now;

        const spawnDist = PLAYER_RADIUS + 10;
        const count = stats.count || 1;
        const spread = stats.spread || 0;

        for(let i=0; i<count; i++) {
            const angleOffset = (Math.random() - 0.5) * spread;
            const finalAngle = data.angle + angleOffset;

            room.bullets.push({
                id: `b_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: player.x + Math.cos(finalAngle) * spawnDist,
                y: player.y + Math.sin(finalAngle) * spawnDist,
                angle: finalAngle,
                speed: stats.speed,
                damage: stats.damage,
                color: stats.color,
                range: stats.range,
                traveled: 0
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
            endGame(targetRoomId, 'draw', null);
        }
    });

    // --- RECONNECT ---
    socket.on('reconnectRequest', (data) => {
        const { roomID, oldSocketID } = data;

        if (rooms[roomID] && rooms[roomID].players[oldSocketID]) {
            // 1. Stop the bleed timer immediately
            if (disconnectTimers[oldSocketID]) {
                clearInterval(disconnectTimers[oldSocketID]);
                delete disconnectTimers[oldSocketID];
            }

            const pData = rooms[roomID].players[oldSocketID];
            
            // Update the socket ID mapping
            delete rooms[roomID].players[oldSocketID];
            rooms[roomID].players[socket.id] = pData;

            socket.join(roomID);
            
            // 2. Tell the player they are back (Load the game)
            socket.emit('reconnectSuccess', { roomID, me: pData, players: rooms[roomID].players });
            
            // 3. Tell EVERYONE to reset state and start countdown
            setTimeout(() => {
                io.to(roomID).emit('matchResumed', { 
                    reconnectedId: socket.id, 
                    resumeIn: 3 
                });
            }, 100); 
            
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
                    io.to(targetRoomId).emit('playerDamage', { id: socket.id, hp: player.hp });

                    if (player.hp <= 0) {
                        const winnerId = Object.keys(rooms[targetRoomId].players).find(id => id !== socket.id);
                        endGame(targetRoomId, "opponent_disconnect", winnerId);
                    }
                } else {
                    clearInterval(disconnectTimers[socket.id]);
                }
            }, 1000);
        }
    });
    
    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

// 6. GAME LOOP
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(rooms[roomId]);
    }
}, TICK_RATE);

function updateRoom(room) {
    if (!room.bullets || room.bullets.length === 0) return;

    let bulletsToRemove = [];
    let stateChanged = false;

    // Move Bullets
    room.bullets.forEach(b => {
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;
        b.traveled += b.speed;

        // Boundaries & Range
        if (b.traveled > b.range || b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) {
            bulletsToRemove.push(b.id);
        }

        // Collision
        for (const playerId in room.players) {
            if (playerId === b.ownerId) continue;

            const player = room.players[playerId];
            if (getDistance(b, player) < PLAYER_RADIUS + 6) { 
                player.hp -= b.damage;
                bulletsToRemove.push(b.id);
                stateChanged = true;

                io.to(room.id).emit('playerDamage', { id: playerId, hp: player.hp });

                if (player.hp <= 0) {
                    endGame(room.id, "kill", b.ownerId);
                    return; 
                }
            }
        }
    });

    // Cleanup
    if (bulletsToRemove.length > 0) {
        room.bullets = room.bullets.filter(b => !bulletsToRemove.includes(b.id));
        stateChanged = true;
    }

    // Sync
    if (stateChanged || room.bullets.length > 0) {
        io.to(room.id).emit('projectilesUpdate', room.bullets);
    }
}

function endGame(roomId, reason, winnerId) {
    if (rooms[roomId]) {
        Object.keys(rooms[roomId].players).forEach(pid => {
            if (disconnectTimers[pid]) {
                clearInterval(disconnectTimers[pid]);
                delete disconnectTimers[pid];
            }
        });

        io.to(roomId).emit('gameOver', { winner: reason, winnerId: winnerId });
        delete rooms[roomId];
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
