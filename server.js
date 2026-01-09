const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ==================================================================
// 1. SETUP SERVER
// ==================================================================
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// ==================================================================
// 2. CONFIGURATION & CONSTANTS
// ==================================================================
const TICK_RATE = 1000 / 60; // 60 Physics calculations per second
const BROADCAST_RATE = 2;    // Only send network updates every 2 ticks (30Hz)

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const BASE_HP = 100;
const PLAYER_RADIUS = 30;

// --- ABILITY CONSTANTS ---
const REGEN_DELAY = 5000;      
const REGEN_RATE = 2;          
const DASH_DURATION = 500;     
const DASH_MULTIPLIER = 2.5;   
const CLOAK_DURATION = 5000;
const SHIELD_DURATION = 10000;

const COOLDOWNS = {
    rifle: 200,   
    pistol: 400,   
    dash: 3000,
    shield: 12000, 
    cloak: 8000,
    repulse: 6000
};

// ==================================================================
// 3. WEAPON DEFINITIONS
// ==================================================================
const WEAPONS = {
    // --- PRIMARY ---
    'pulse': { type: 'gun', damage: 12, speed: 22, cooldown: 140, range: 1100, color: '#00f3ff', desc: "Standard Rifle" },
    'rail':  { type: 'gun', damage: 40, speed: 60, cooldown: 1500, range: 3000, color: '#ff0055', pierce: true, desc: "Piercing Sniper" },
    'scatter': { type: 'gun', damage: 7, speed: 22, cooldown: 850, range: 550, color: '#ffff00', count: 6, spread: 0.4, desc: "Shotgun" },
    'void':  { type: 'gun', damage: 20, speed: 14, cooldown: 1800, range: 1100, color: '#9900ff', size: 14, explosive: true, blastRadius: 180, blastDamage: 40, desc: "Explosive Launcher" },
    'twin':  { type: 'gun', damage: 8, speed: 26, cooldown: 60, range: 750, color: '#00ffaa', desc: "Rapid SMG" },

    // --- SECONDARY ---
    'pistol': { type: 'gun', damage: 14, speed: 20, cooldown: 300, range: 900, color: '#cccccc', desc: "Sidearm" },
    'mag':    { type: 'gun', damage: 32, speed: 30, cooldown: 700, range: 1200, color: '#ffaa00', desc: "Heavy Pistol" },
    'knife':  { type: 'gun', damage: 60, speed: 35, cooldown: 500, range: 100, color: '#ffffff', size: 10, desc: "Melee Slash" },
    'mine':   { type: 'mine', damage: 60, speed: 0, cooldown: 4000, range: 9999, color: '#ff0000', life: 8000, desc: "Proximity Mine" },

    // --- UTILITIES ---
    'repulse': { cooldown: COOLDOWNS.repulse },
    'dash':    { cooldown: COOLDOWNS.dash },
    'shield':  { cooldown: COOLDOWNS.shield },
    'cloak':   { cooldown: COOLDOWNS.cloak }
};

// ==================================================================
// 4. STATE MANAGEMENT
// ==================================================================
let rooms = {}; 
let waitingPlayer = null; 
let disconnectTimers = {}; 

function getDistance(a, b) {
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

// ==================================================================
// 5. SOCKET LOGIC
// ==================================================================
io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- MATCHMAKING ---
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

        const startingHp = chosenPerk === 'vitality' ? 125 : BASE_HP;

        // Construct Player Object
        const finalPlayerData = {
            username: cleanName,
            perk: chosenPerk,
            primary:   WEAPONS[playerData.primary]    ? playerData.primary    : 'pulse',
            secondary: WEAPONS[playerData.secondary] ? playerData.secondary : 'pistol',
            utility:   playerData.utility || 'dash'
        };

        const newPlayerState = {
            ...finalPlayerData,
            id: socket.id,
            hp: startingHp, 
            maxHp: startingHp,
            x: 0, y: 0, angle: 0,
            
            // PHYSICS ADDITION: Velocity
            vx: 0, 
            vy: 0, 
            
            // NEW: State Tracking
            lastShootTime: 0,
            lastDamageTime: 0, // For Regen
            cooldowns: { primary: 0, secondary: 0, utility: 0 },
            
            // Status Flags
            shield: false,
            invisible: false,
            speedMult: 1.0
        };

        if (waitingPlayer) {
            // Match Found
            const roomID = `room_${Date.now()}`;
            const p1ID = waitingPlayer.id;
            const p2ID = socket.id;

            // Set Spawn Positions
            const p1State = { ...waitingPlayer.state, id: p1ID, x: 100, y: 540, angle: 0 };
            const p2State = { ...newPlayerState, id: p2ID, x: 1820, y: 540, angle: Math.PI };

            rooms[roomID] = {
                id: roomID,
                tickCount: 0, // Used for throttling updates
                bullets: [],
                players: {
                    [p1ID]: p1State,
                    [p2ID]: p2State
                }
            };

            waitingPlayer.socket.join(roomID);
            socket.join(roomID);

            io.to(roomID).emit('matchFound', { roomID, players: rooms[roomID].players });
            waitingPlayer = null; 
        } else {
            // Wait in Queue
            waitingPlayer = { 
                id: socket.id, 
                socket: socket, 
                data: finalPlayerData,
                state: newPlayerState
            };
        }
    });

    // --- MOVEMENT ---
    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
            const player = rooms[data.roomID].players[socket.id];
            
            // === CRITICAL FIX FOR PHYSICS ===
            // If the player is being knocked back (high velocity on server), 
            // IGNORE the client's x/y to prevent snapping back.
            // Only accept client position if server velocity is low (normal movement)
            if (Math.abs(player.vx) < 1 && Math.abs(player.vy) < 1) {
                player.x = data.x;
                player.y = data.y;
            }

            player.angle = data.angle;
            
            // NOTE: We do NOT emit opponentUpdate here anymore. 
            // We let the Game Loop handle it at a steady 30Hz rate.
            // This prevents "Flood" lag.
        }
    });

    // --- SHOOTING & ABILITIES ---
    socket.on('playerShoot', (data) => {
        const room = rooms[data.roomID];
        if (!room || !room.players[socket.id]) return;

        const p = room.players[socket.id];
        const now = Date.now();
        const slot = data.slot; // 'primary', 'secondary', 'utility'

        // 1. Check Global Cooldown for this slot
        if (p.cooldowns[slot] > now) return; 

        // 2. UTILITY LOGIC
        if (slot === 'utility') {
            const utilType = p.utility;
            let cdTime = 0;

            if (utilType === 'dash') {
                // SERVER SIDE DASH PHYSICS
                // Instead of just setting speedMult, we apply raw velocity
                const dashPower = 30;
                p.vx = Math.cos(p.angle) * dashPower;
                p.vy = Math.sin(p.angle) * dashPower;

                p.speedMult = DASH_MULTIPLIER;
                io.to(room.id).emit('applyBuff', { id: socket.id, type: 'speed', val: p.speedMult, duration: DASH_DURATION });
                
                setTimeout(() => { 
                    if(rooms[data.roomID]?.players[socket.id]) p.speedMult = 1.0; 
                }, DASH_DURATION);
                
                cdTime = COOLDOWNS.dash;
            } 
            else if (utilType === 'shield') {
                p.shield = true;
                cdTime = 0; 
                
                setTimeout(() => {
                    if(rooms[data.roomID]?.players[socket.id]?.shield) {
                        rooms[data.roomID].players[socket.id].shield = false;
                        rooms[data.roomID].players[socket.id].cooldowns.utility = Date.now() + COOLDOWNS.shield;
                        io.to(data.roomID).emit('cooldownUpdate', { id: socket.id, cooldowns: rooms[data.roomID].players[socket.id].cooldowns });
                    }
                }, SHIELD_DURATION);
            }
            else if (utilType === 'cloak') {
                p.invisible = true;
                cdTime = COOLDOWNS.cloak;
                setTimeout(() => { 
                    if(rooms[data.roomID]?.players[socket.id]) p.invisible = false; 
                }, CLOAK_DURATION);
            }
            else if (utilType === 'repulse') {
                cdTime = COOLDOWNS.repulse;
                io.to(room.id).emit('visualEffect', { type: 'repulse', x: p.x, y: p.y });

                Object.keys(room.players).forEach(pid => {
                    if (pid === socket.id) return;
                    const enemy = room.players[pid];
                    const dx = enemy.x - p.x;
                    const dy = enemy.y - p.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    if (dist < 400) { // Range
                        const angle = Math.atan2(dy, dx);
                        
                        // SERVER SIDE REPULSE PHYSICS
                        const force = 30; // Strong push
                        enemy.vx += Math.cos(angle) * force;
                        enemy.vy += Math.sin(angle) * force;

                        // Emit forcePush so opponent client knows they were hit
                        io.to(pid).emit('forcePush', { angle: angle, force: 15 }); 
                    }
                });
            }

            if (utilType !== 'shield') {
                p.cooldowns.utility = now + cdTime;
            }
            
            io.to(room.id).emit('cooldownUpdate', { id: socket.id, cooldowns: p.cooldowns });
            return;
        }

        // 3. WEAPON LOGIC
        if (p.invisible) {
            p.invisible = false;
        }

        const weaponKey = slot === 'primary' ? p.primary : p.secondary;
        const stats = WEAPONS[weaponKey];
        
        let actualCD = stats.cooldown;
        if (p.perk === 'haste') actualCD *= 0.85;
        p.cooldowns[slot] = now + actualCD;

        // Mine Logic
        if (stats.type === 'mine') {
            let actualDamage = stats.damage;
            if (p.perk === 'lethality') actualDamage *= 1.15;
            room.bullets.push({
                id: `m_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: p.x, y: p.y, angle: 0, speed: 0,
                damage: actualDamage, color: stats.color, range: stats.life,
                traveled: 0, isMine: true
            });
            io.to(room.id).emit('cooldownUpdate', { id: socket.id, cooldowns: p.cooldowns });
            return;
        }

        // Gun Logic
        const count = stats.count || 1;
        const spread = stats.spread || 0; 
        const spawnDist = PLAYER_RADIUS + 15;
        
        let startAngle = data.angle;
        if (count > 1) startAngle = data.angle - (spread / 2); 

        for(let i = 0; i < count; i++) {
            let finalAngle;
            if (count === 1) finalAngle = data.angle;
            else if (spread >= 6.28) finalAngle = data.angle + (i * (Math.PI * 2 / count));
            else finalAngle = startAngle + (i * (spread / (count - 1)));

            let actualDamage = stats.damage;
            if (p.perk === 'lethality') actualDamage = Math.ceil(actualDamage * 1.15);

            room.bullets.push({
                id: `b_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: p.x + Math.cos(finalAngle) * spawnDist,
                y: p.y + Math.sin(finalAngle) * spawnDist,
                angle: finalAngle,
                speed: stats.speed,
                damage: actualDamage,
                color: stats.color,
                range: stats.range,
                traveled: 0,
                pierce: stats.pierce || false,
                hitList: [],
                explosive: stats.explosive || false,
                blastRadius: stats.blastRadius || 0,
                blastDamage: stats.blastDamage || 0
            });
        }
        
        io.to(room.id).emit('cooldownUpdate', { id: socket.id, cooldowns: p.cooldowns });
    });

    // --- ABANDON MATCH ---
    socket.on('abandonMatch', () => {
        findRoomAndEnd(socket.id, 'draw', null);
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
            pData.id = socket.id;
            
            pData.vx = 0;
            pData.vy = 0;

            socket.join(roomID);
            socket.emit('reconnectSuccess', { roomID, me: pData, players: rooms[roomID].players });
            setTimeout(() => {
                io.to(roomID).emit('matchResumed', { reconnectedId: socket.id, resumeIn: 3 });
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
            disconnectTimers[socket.id] = setInterval(() => {
                if (!rooms[targetRoomId]) {
                    clearInterval(disconnectTimers[socket.id]); 
                    return;
                }
                const player = rooms[targetRoomId].players[socket.id];
                if (player) {
                    player.hp -= 5; // Bleed damage
                    io.to(targetRoomId).emit('playerDamage', { id: socket.id, hp: player.hp });
                    if (player.hp <= 0) {
                        const winnerId = Object.keys(rooms[targetRoomId].players).find(id => id !== socket.id);
                        endGame(targetRoomId, "opponent_disconnect", winnerId, socket.id);
                    }
                } else {
                    clearInterval(disconnectTimers[socket.id]);
                }
            }, 1000);
        }
    });

    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

// ==================================================================
// 6. GAME LOOP (PHYSICS & REGEN)
// ==================================================================
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(rooms[roomId]);
    }
}, TICK_RATE);

function updateRoom(room) {
    const now = Date.now();
    let stateChanged = false;
    
    // Increment Tick Counter
    room.tickCount = (room.tickCount || 0) + 1;
    const shouldBroadcast = room.tickCount % BROADCAST_RATE === 0;

    // 1. PHYSICS UPDATE FOR PLAYERS
    const playerIds = Object.keys(room.players);
    let anyPlayerMoved = false;

    playerIds.forEach(pid => {
        const p = room.players[pid];

        // Apply Velocity (Repulse/Dash)
        if (Math.abs(p.vx) > 0.1 || Math.abs(p.vy) > 0.1) {
            p.x += p.vx;
            p.y += p.vy;
            
            // Friction
            p.vx *= 0.92;
            p.vy *= 0.92;

            // Stop if too slow
            if (Math.abs(p.vx) < 0.1) p.vx = 0;
            if (Math.abs(p.vy) < 0.1) p.vy = 0;

            // Map Boundaries
            if (p.x < PLAYER_RADIUS) { p.x = PLAYER_RADIUS; p.vx *= -0.5; }
            if (p.x > MAP_WIDTH - PLAYER_RADIUS) { p.x = MAP_WIDTH - PLAYER_RADIUS; p.vx *= -0.5; }
            if (p.y < PLAYER_RADIUS) { p.y = PLAYER_RADIUS; p.vy *= -0.5; }
            if (p.y > MAP_HEIGHT - PLAYER_RADIUS) { p.y = MAP_HEIGHT - PLAYER_RADIUS; p.vy *= -0.5; }

            anyPlayerMoved = true;
        }

        // Regen Logic
        if (p.hp < p.maxHp && p.hp > 0) {
            if (now - p.lastDamageTime > REGEN_DELAY) {
                p.hp = Math.min(p.maxHp, p.hp + (REGEN_RATE / 60)); 
            }
        }
    });

    // === NETWORK THROTTLING ===
    // We only send updates every 2nd or 3rd tick to prevent packet bunching/teleporting.
    // AND we send updates if the server moved the player (Repulse), overriding client lag.
    if (shouldBroadcast) {
        if (playerIds.length === 2) {
            const p1 = room.players[playerIds[0]];
            const p2 = room.players[playerIds[1]];
            
            // We include vx/vy so the client *could* predict if you wanted, 
            // but mostly this steady 30Hz stream prevents the "Teleport" effect.
            io.to(playerIds[1]).emit('opponentUpdate', { 
                x: p1.x, y: p1.y, vx: p1.vx, vy: p1.vy, angle: p1.angle, 
                invisible: p1.invisible, shield: p1.shield 
            });
            io.to(playerIds[0]).emit('opponentUpdate', { 
                x: p2.x, y: p2.y, vx: p2.vx, vy: p2.vy, angle: p2.angle, 
                invisible: p2.invisible, shield: p2.shield 
            });
        }
    }

    // 2. BULLET LOGIC
    if (!room.bullets || room.bullets.length === 0) return;

    let bulletsToRemove = [];

    room.bullets.forEach(b => {
        // Move Projectiles
        if (!b.isMine) {
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.traveled += b.speed;
        } else {
            b.traveled += 16; 
        }

        if (b.traveled > b.range || b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) {
            bulletsToRemove.push(b.id);
        }

        for (const playerId in room.players) {
            const player = room.players[playerId];

            if (playerId === b.ownerId && (!b.isMine || b.traveled < 500)) continue;
            if (b.pierce && b.hitList.includes(playerId)) continue;

            if (getDistance(b, player) < PLAYER_RADIUS + 6) { 
                if (player.shield) {
                    player.shield = false; 
                    player.cooldowns.utility = Date.now() + COOLDOWNS.shield;
                    io.to(room.id).emit('visualEffect', { type: 'shieldBreak', x: player.x, y: player.y });
                    io.to(room.id).emit('cooldownUpdate', { id: playerId, cooldowns: player.cooldowns });
                    io.to(room.id).emit('opponentUpdate', { id: playerId, x: player.x, y: player.y, angle: player.angle, shield: false });
                    bulletsToRemove.push(b.id);
                    break;
                } 
                else {
                    player.hp -= b.damage;
                    player.lastDamageTime = Date.now(); 

                    if (b.explosive) {
                        for(const targetId in room.players) {
                             if(targetId === b.ownerId) continue; 
                             const target = room.players[targetId];
                             const dist = getDistance({x: b.x, y: b.y}, target);
                             if (dist < b.blastRadius) {
                                 target.hp -= b.blastDamage; 
                                 target.lastDamageTime = Date.now();
                             }
                        }
                    }
                    
                    io.to(room.id).emit('playerDamage', { id: playerId, hp: player.hp });

                    if (player.hp <= 0) {
                        endGame(room.id, "kill", b.ownerId, playerId);
                        return; 
                    }

                    if (b.pierce) {
                        b.hitList.push(playerId);
                    } else {
                        bulletsToRemove.push(b.id);
                        break; 
                    }
                }
            }
        }
    });

    if (bulletsToRemove.length > 0) {
        room.bullets = room.bullets.filter(b => !bulletsToRemove.includes(b.id));
        stateChanged = true;
    }

    // Only send bullet updates on the broadcast tick OR if bullets changed state (hit/die)
    if (stateChanged || (room.bullets.length > 0 && shouldBroadcast)) {
        io.to(room.id).emit('projectilesUpdate', room.bullets);
    }
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
            if (disconnectTimers[pid]) {
                clearInterval(disconnectTimers[pid]);
                delete disconnectTimers[pid];
            }
        });

        if (!loserId && winnerId) {
            loserId = Object.keys(rooms[roomId].players).find(id => id !== winnerId);
        }

        io.to(roomId).emit('gameOver', { 
            winner: reason, 
            winnerId: winnerId,
            loserId: loserId 
        });
        delete rooms[roomId];
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
