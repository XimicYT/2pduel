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

// ==================================================================
// 1. CONFIGURATION
// ==================================================================
const TICK_RATE = 1000 / 60; 
const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const BASE_HP = 100;
const BLEED_DAMAGE = 5; 
const PLAYER_RADIUS = 30;

// ==================================================================
// 2. WEAPON & UTILITY DEFINITIONS
// ==================================================================
const WEAPONS = {
    // --- PRIMARY WEAPONS ---
    'pulse': { 
        type: 'gun', 
        damage: 12,     // 9 shots to kill
        speed: 22,      // Standard travel time
        cooldown: 140,  // Fast fire rate
        range: 1100,    // Mid-Long range
        color: '#00f3ff',
        desc: "Standard Energy Rifle. Reliable."
    }, 
    'rail': { 
        type: 'gun', 
        damage: 45,     // 3 shots to kill (High Burst)
        speed: 50,      // Near instant hit
        cooldown: 1300, // Very slow fire rate
        range: 2500,    // Cross-map range
        color: '#ff0055',
        desc: "High velocity Sniper. Precision required."
    }, 
    'scatter': { 
        type: 'gun', 
        damage: 7,      // Per pellet (6 pellets = 42 potential dmg)
        speed: 22, 
        cooldown: 850, 
        range: 550,     // Short range only
        color: '#ffff00', 
        count: 6,       // Fires 6 bullets at once
        spread: 0.4,    // Wide cone
        desc: "Shotgun. Devastating close range."
    }, 
    'void': { 
        type: 'gun', 
        damage: 55,     // Massive damage
        speed: 13,      // Very slow projectile (Dodgeable)
        cooldown: 1800, 
        range: 1200, 
        color: '#9900ff', 
        size: 14,       // Larger hitbox
        desc: "Plasma Launcher. Slow but deadly."
    }, 
    'twin': { 
        type: 'gun', 
        damage: 8,      // Low dmg
        speed: 26, 
        cooldown: 60,   // Extreme fire rate (Machine gun)
        range: 750, 
        color: '#00ffaa', 
        desc: "Rapid fire SMG. Spray and pray."
    }, 

    // --- SECONDARY WEAPONS ---
    'pistol': { 
        type: 'gun', damage: 14, speed: 20, cooldown: 300, range: 900, color: '#cccccc',
        desc: "Standard sidearm."
    },
    'mag': { 
        type: 'gun', damage: 32, speed: 30, cooldown: 700, range: 1200, color: '#ffaa00',
        desc: "Heavy Pistol. Good finisher."
    }, 
    'mine': { 
        type: 'mine', 
        damage: 60, 
        speed: 0, 
        cooldown: 4000, 
        range: 9999, // Range acts as lifetime for mines
        color: '#ff0000', 
        life: 8000, // Lasts 8 seconds on floor
        desc: "Stationary proximity mine."
    }, 

    // --- UTILITIES ---
    'repulse': { 
        type: 'gun', 
        damage: 15, 
        speed: 12, 
        cooldown: 5000, 
        range: 350, 
        color: '#ffffff', 
        count: 16,      // 16 bullets in a circle
        spread: 6.28,   // 360 degrees
        desc: "Shockwave. Pushes enemies back."
    }, 
    'dash': { 
        type: 'dash', 
        distance: 250, 
        cooldown: 2500,
        desc: "Instant teleport forward."
    },
    
    // Fallback
    'default': { type: 'gun', damage: 10, speed: 20, cooldown: 200 }
};

// ==================================================================
// 3. STATE & HELPERS
// ==================================================================
let rooms = {}; 
let waitingPlayer = null; 
let disconnectTimers = {}; 

function getDistance(a, b) {
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

// ==================================================================
// 4. SOCKET LOGIC
// ==================================================================
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- JOIN QUEUE ---
    socket.on('joinQueue', (playerData) => {
        const cleanName = (playerData.username || "Agent").substring(0, 12).replace(/[^a-zA-Z0-9 _-]/g, "");
        const chosenPerk = playerData.perk || 'vitality';
        
        // Check Name Uniqueness
        let nameTaken = false;
        if (waitingPlayer && waitingPlayer.data.username === cleanName) nameTaken = true;
        if (!nameTaken) {
            for (const rID in rooms) {
                const players = rooms[rID].players;
                for (const pID in players) {
                    if (players[pID].username === cleanName) { nameTaken = true; break; }
                }
                if (nameTaken) break;
            }
        }
        if (nameTaken) {
            socket.emit('queueError', 'NAME ALREADY IN USE.');
            return;
        }

        // PERK LOGIC: HEALTH
        // If Perk is Vitality, HP is 125, else 100.
        const startingHp = chosenPerk === 'vitality' ? 125 : BASE_HP;

        const finalPlayerData = {
            username: cleanName,
            perk: chosenPerk, // Store perk so client knows (for speed)
            primary:   WEAPONS[playerData.primary]   ? playerData.primary   : 'pulse',
            secondary: WEAPONS[playerData.secondary] ? playerData.secondary : 'pistol',
            utility:   WEAPONS[playerData.utility]   ? playerData.utility   : 'repulse'
        };

        if (waitingPlayer) {
            // MATCH FOUND
            const roomID = `room_${Date.now()}`;
            const p1ID = waitingPlayer.id;
            const p2ID = socket.id;

            rooms[roomID] = {
                id: roomID,
                bullets: [],
                players: {
                    [p1ID]: { 
                        ...waitingPlayer.data, id: p1ID,
                        hp: waitingPlayer.hp, maxHp: waitingPlayer.hp, // Use calculated HP
                        x: 100, y: 540, angle: 0,
                        lastShootTime: 0 
                    },
                    [p2ID]: { 
                        ...finalPlayerData, id: p2ID,
                        hp: startingHp, maxHp: startingHp, // Use calculated HP
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
            // WAITING
            waitingPlayer = { 
                id: socket.id, 
                socket: socket, 
                data: finalPlayerData,
                hp: startingHp // Store HP for when match starts
            };
        }
    });

    // --- MOVEMENT ---
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const player = rooms[data.roomID].players[socket.id];
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;
            
            socket.to(data.roomID).emit('opponentUpdate', { 
                id: socket.id, x: data.x, y: data.y, angle: data.angle 
            });
        }
    });

    // --- SHOOTING & ABILITIES ---
    socket.on('playerShoot', (data) => {
        const room = rooms[data.roomID];
        if (!room || !room.players[socket.id]) return;

        const player = room.players[socket.id];
        const weaponKey = player[data.slot]; 
        const stats = WEAPONS[weaponKey] || WEAPONS['default'];

        // PERK LOGIC: HASTE (Cooldown Reduction)
        let actualCooldown = stats.cooldown;
        if (player.perk === 'haste') actualCooldown *= 0.85; // 15% faster

        const now = Date.now();
        if (now - player.lastShootTime < actualCooldown) return;
        player.lastShootTime = now;

        // --- DASH ---
        if (stats.type === 'dash') {
            const dashDist = stats.distance;
            let newX = player.x + Math.cos(player.angle) * dashDist;
            let newY = player.y + Math.sin(player.angle) * dashDist;

            newX = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, newX));
            newY = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, newY));

            player.x = newX;
            player.y = newY;
            io.to(room.id).emit('opponentUpdate', { id: socket.id, x: player.x, y: player.y, angle: player.angle });
            return;
        }

        // --- MINES ---
        if (stats.type === 'mine') {
            // PERK LOGIC: LETHALITY (Damage Boost)
            let actualDamage = stats.damage;
            if (player.perk === 'lethality') actualDamage *= 1.15; 

            room.bullets.push({
                id: `m_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: player.x,
                y: player.y,
                angle: 0,
                speed: 0,
                damage: actualDamage,
                color: stats.color,
                range: stats.life, 
                traveled: 0,
                isMine: true
            });
            return;
        }

        // --- GUNS ---
        const count = stats.count || 1;
        const spread = stats.spread || 0; 
        const spawnDist = PLAYER_RADIUS + 15;
        
        let startAngle = data.angle;
        if (count > 1) startAngle = data.angle - (spread / 2); 

        for(let i = 0; i < count; i++) {
            let finalAngle;
            const step = spread / (count > 1 ? count - 1 : 1);
            if (count === 1) finalAngle = data.angle; 
            else if (spread >= 6.28) finalAngle = data.angle + (i * (Math.PI * 2 / count));
            else finalAngle = startAngle + (i * step);

            // PERK LOGIC: LETHALITY (Damage Boost)
            let actualDamage = stats.damage;
            if (player.perk === 'lethality') actualDamage = Math.ceil(actualDamage * 1.15);

            room.bullets.push({
                id: `b_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: player.x + Math.cos(finalAngle) * spawnDist,
                y: player.y + Math.sin(finalAngle) * spawnDist,
                angle: finalAngle,
                speed: stats.speed,
                damage: actualDamage,
                color: stats.color,
                range: stats.range,
                traveled: 0
            });
        }
    });

    // --- GAME END LOGIC ---
    socket.on('abandonMatch', () => findRoomAndEnd(socket.id, 'draw', null));

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
            pData.id = socket.id;

            socket.join(roomID);
            socket.emit('reconnectSuccess', { roomID, me: pData, players: rooms[roomID].players });
            setTimeout(() => io.to(roomID).emit('matchResumed', { reconnectedId: socket.id, resumeIn: 3 }), 100);
        } else {
            socket.emit('reconnectFailed');
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
            return;
        }
        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) { targetRoomId = rID; break; }
        }
        if (targetRoomId) {
            io.to(targetRoomId).emit('opponentDisconnected', { id: socket.id });
            disconnectTimers[socket.id] = setInterval(() => {
                if (!rooms[targetRoomId]) { clearInterval(disconnectTimers[socket.id]); return; }
                const player = rooms[targetRoomId].players[socket.id];
                if (player) {
                    player.hp -= BLEED_DAMAGE;
                    io.to(targetRoomId).emit('playerDamage', { id: socket.id, hp: player.hp });
                    if (player.hp <= 0) {
                        const winnerId = Object.keys(rooms[targetRoomId].players).find(id => id !== socket.id);
                        endGame(targetRoomId, "opponent_disconnect", winnerId, socket.id);
                    }
                } else clearInterval(disconnectTimers[socket.id]);
            }, 1000);
        }
    });

    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

// ==================================================================
// 5. SERVER LOOP
// ==================================================================
setInterval(() => {
    for (const roomId in rooms) updateRoom(rooms[roomId]);
}, TICK_RATE);

function updateRoom(room) {
    if (!room.bullets || room.bullets.length === 0) return;
    let bulletsToRemove = [];
    let stateChanged = false;

    room.bullets.forEach(b => {
        if (!b.isMine) {
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.traveled += b.speed;
        } else {
            b.traveled += 16; // Mine lifetime ticker
        }

        if (b.traveled > b.range || b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) {
            bulletsToRemove.push(b.id);
        }

        for (const playerId in room.players) {
            if (playerId === b.ownerId && b.traveled < 500) continue; // Safe time for mines
            const player = room.players[playerId];
            if (getDistance(b, player) < PLAYER_RADIUS + 6) { 
                player.hp -= b.damage;
                bulletsToRemove.push(b.id);
                stateChanged = true;
                io.to(room.id).emit('playerDamage', { id: playerId, hp: player.hp });
                if (player.hp <= 0) {
                    endGame(room.id, "kill", b.ownerId, playerId);
                    return; 
                }
            }
        }
    });

    if (bulletsToRemove.length > 0) {
        room.bullets = room.bullets.filter(b => !bulletsToRemove.includes(b.id));
        stateChanged = true;
    }
    if (stateChanged || room.bullets.length > 0) io.to(room.id).emit('projectilesUpdate', room.bullets);
}

function findRoomAndEnd(socketId, reason, winnerId) {
    for (const rID in rooms) {
        if (rooms[rID].players[socketId]) {
            endGame(rID, reason, winnerId, null);
            break;
        }
    }
}

function endGame(roomId, reason, winnerId, loserId) {
    if (rooms[roomId]) {
        Object.keys(rooms[roomId].players).forEach(pid => {
            if (disconnectTimers[pid]) { clearInterval(disconnectTimers[pid]); delete disconnectTimers[pid]; }
        });
        if (!loserId && winnerId) loserId = Object.keys(rooms[roomId].players).find(id => id !== winnerId);
        io.to(roomId).emit('gameOver', { winner: reason, winnerId: winnerId, loserId: loserId });
        delete rooms[roomId];
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
