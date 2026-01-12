const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// ==================================================================
// 1. SETUP SERVER
// ==================================================================
const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;

// ==================================================================
// 2. CONFIGURATION & CONSTANTS
// ==================================================================
const TICK_RATE = 1000 / 60;
const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const PLAYER_RADIUS = 30;
const COUNTDOWN_TIME = 3000;

// --- ABILITY CONSTANTS ---
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
    repulse: 6000,
};

// ==================================================================
// 3. WEAPON DEFINITIONS
// ==================================================================
const WEAPONS = {
    // --- PRIMARY ---
    pulse: { type: "gun", damage: 12, speed: 22, cooldown: 140, range: 1100, color: "#00f3ff", desc: "Standard Rifle" },
    rail: { type: "gun", damage: 40, speed: 60, cooldown: 1500, range: 3000, color: "#ff0055", pierce: true, desc: "Piercing Sniper" },
    scatter: { type: "gun", damage: 7, speed: 22, cooldown: 850, range: 550, color: "#ffff00", count: 6, spread: 0.4, desc: "Shotgun" },
    void: { 
        type: "gun", 
        damage: 15,          // Direct impact damage (low)
        speed: 16,           // Slower projectile
        cooldown: 1800, 
        range: 1000, 
        color: "#9900ff", 
        size: 16, 
        pierce: false,       // STOP on impact
        explosive: true,     // Custom flag for our logic
        blastRadius: 220,    // Size of explosion
        blastDamage: 70,     // Max damage at center
        desc: "Proximity Launcher" 
    },
    twin: { type: "gun", damage: 8, speed: 26, cooldown: 60, range: 750, color: "#00ffaa", desc: "Rapid SMG" },

    // --- SECONDARY ---
    pistol: { type: "gun", damage: 14, speed: 20, cooldown: 300, range: 900, color: "#cccccc", desc: "Sidearm" },
    mag: { type: "gun", damage: 32, speed: 30, cooldown: 700, range: 1200, color: "#ffaa00", desc: "Heavy Pistol" },
    knife: { type: "gun", damage: 60, speed: 35, cooldown: 500, range: 100, color: "#ffffff", size: 10, desc: "Melee Slash" },
    mine: { type: "mine", damage: 60, speed: 0, cooldown: 4000, range: 9999, color: "#ff0000", life: 8000, desc: "Proximity Mine" },

    // --- UTILITIES ---
    repulse: { cooldown: COOLDOWNS.repulse },
    dash: { cooldown: COOLDOWNS.dash },
    shield: { cooldown: COOLDOWNS.shield },
    cloak: { cooldown: COOLDOWNS.cloak },
};

// ==================================================================
// 4. STATE MANAGEMENT
// ==================================================================
let rooms = {};
let waitingPlayers = [];
let disconnectTimers = {};

// Helper: Resolve the Persistent Player ID from the Current Socket ID
function getPlayerId(room, socketId) {
    if (!room || !room.socketMap) return socketId;
    return room.socketMap[socketId] || socketId;
}

// ==================================================================
// 5. SOCKET LOGIC
// ==================================================================
io.on("connection", (socket) => {

    console.log(`[CONNECT] User Connected: ${socket.id}`);
    io.emit("playerCount", io.engine.clientsCount);

    // ===============================================
    //  JOIN QUEUE
    // ===============================================
    socket.on("joinQueue", (data) => {

        const rawUsername = data.username ? data.username.substring(0, 15) : "Agent";
        const cleanUsername = rawUsername.trim();

        // CHECK USERNAME UNIQUENESS
        const nameTaken = waitingPlayers.some(p =>
            p.userData &&
            p.userData.username.toLowerCase() === cleanUsername.toLowerCase()
        );

        if (nameTaken) {
            socket.emit("queueError", "Username taken. Choose another.");
            return;
        }

        // SAVE USER DATA
        if (data) {
            socket.userData = {
                username: cleanUsername,
                perk: data.perk || "vitality",
                primary: data.primary || "pulse",
                secondary: data.secondary || "pistol",
                utility: data.utility || "dash"
            };
        }

        // CHECK FOR REJOIN TOKEN
        if (data && data.token) {
            const token = data.token;
            for (const rID in rooms) {
                const room = rooms[rID];
                const pID = Object.keys(room.players).find(
                    (id) => room.players[id].matchToken === token
                );

                if (pID) {
                    console.log(`[REJOIN] Token found for room ${rID}`);
                    handleRejoin(socket, token);
                    return;
                }
            }
        }

        if (waitingPlayers.some(s => s.id === socket.id)) return;

        console.log(`[QUEUE] Player ${socket.id} (${cleanUsername}) joined queue`);
        waitingPlayers.push(socket);

        waitingPlayers = waitingPlayers.filter(s => s.connected);

        if (waitingPlayers.length >= 2) {
            const p1 = waitingPlayers.shift();
            const p2 = waitingPlayers.shift();

            if (!p1.connected || !p2.connected) {
                if (p1.connected) waitingPlayers.unshift(p1);
                if (p2.connected) waitingPlayers.unshift(p2);
                return;
            }

            const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const token1 = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const token2 = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            const p1Data = p1.userData || { username: "P1", perk: "vitality", primary: "pulse", secondary: "pistol", utility: "dash" };
            const p2Data = p2.userData || { username: "P2", perk: "vitality", primary: "pulse", secondary: "pistol", utility: "dash" };

            rooms[roomId] = {
                id: roomId,
                gameStartTime: Date.now() + COUNTDOWN_TIME,
                // NEW: Socket Map to track ID changes
                socketMap: {
                    [p1.id]: p1.id,
                    [p2.id]: p2.id
                },
                players: {
                    [p1.id]: {
                        id: p1.id, x: 100, y: MAP_HEIGHT / 2,
                        hp: 100, maxHp: 100, color: "red", score: 0, connected: true, matchToken: token1,
                        cooldowns: {}, angle: 0, vx: 0, vy: 0,
                        username: p1Data.username, perk: p1Data.perk,
                        primary: p1Data.primary, secondary: p1Data.secondary, utility: p1Data.utility,
                        keys: {}, isShooting: false
                    },
                    [p2.id]: {
                        id: p2.id, x: MAP_WIDTH - 100, y: MAP_HEIGHT / 2,
                        hp: 100, maxHp: 100, color: "blue", score: 0, connected: true, matchToken: token2,
                        cooldowns: {}, angle: Math.PI, vx: 0, vy: 0,
                        username: p2Data.username, perk: p2Data.perk,
                        primary: p2Data.primary, secondary: p2Data.secondary, utility: p2Data.utility,
                        keys: {}, isShooting: false
                    },
                },
                bullets: [],
                tickCount: 0,
                lastUpdate: Date.now(),
            };

            // Apply Vitality Perk
            if (rooms[roomId].players[p1.id].perk === "vitality") {
                rooms[roomId].players[p1.id].maxHp = 130;
                rooms[roomId].players[p1.id].hp = 130;
            }
            if (rooms[roomId].players[p2.id].perk === "vitality") {
                rooms[roomId].players[p2.id].maxHp = 130;
                rooms[roomId].players[p2.id].hp = 130;
            }

            p1.join(roomId);
            p2.join(roomId);

            const roomData = {
                roomId,
                roomID: roomId,
                players: rooms[roomId].players
            };

            p1.emit("matchFound", { ...roomData, playerId: p1.id, matchToken: token1 });
            p2.emit("matchFound", { ...roomData, playerId: p2.id, matchToken: token2 });

            console.log(`[MATCH] Created Room ${roomId}`);
        }
    });

    // ===============================================
    //  REJOIN GAME (THE FIX)
    // ===============================================
    socket.on("rejoinGame", (data) => {
        handleRejoin(socket, data.token);
    });

    function handleRejoin(sock, token) {
        if (!token) return;

        let foundRoomId = null;
        let oldSocketId = null;

        for (const rID in rooms) {
            const room = rooms[rID];
            const pID = Object.keys(room.players).find(
                (id) => room.players[id].matchToken === token
            );
            if (pID) {
                foundRoomId = rID;
                oldSocketId = pID;
                break;
            }
        }

        if (foundRoomId && oldSocketId) {
            const room = rooms[foundRoomId];
            
            // FIX: Don't replace the object key. Map new socket to OLD key.
            // This ensures the opponent still sees updates for the same ID.
            room.socketMap[sock.id] = oldSocketId;
            room.players[oldSocketId].connected = true;

            sock.join(foundRoomId);

            if (disconnectTimers[oldSocketId]) {
                clearTimeout(disconnectTimers[oldSocketId]);
                delete disconnectTimers[oldSocketId];
            }

            // Send back the ORIGINAL player ID data
            sock.emit("rejoinSuccess", {
                roomId: foundRoomId,
                roomID: foundRoomId,
                me: room.players[oldSocketId], 
                players: room.players
            });

            // Tell opponent the original ID has returned
            io.to(foundRoomId).emit("matchResumed", { reconnectedId: oldSocketId });
            
            console.log(`[REJOIN] Success. Mapped ${sock.id} to ${oldSocketId}`);
        } else {
            sock.emit("rejoinFailed");
        }
    }

    // ===============================================
    //  FORFEIT LOGIC
    // ===============================================
    socket.on("forfeitMatch", (data) => {
        // ... (Logic mostly same, just checking ID safety)
        if (data && data.matchToken) {
            const token = data.matchToken;
            let targetRoomId = null;
            let forfeiterId = null;
            for (const rID in rooms) {
                const room = rooms[rID];
                const pID = Object.keys(room.players).find((id) => room.players[id].matchToken === token);
                if (pID) {
                    targetRoomId = rID;
                    forfeiterId = pID;
                    break;
                }
            }
            if (targetRoomId && forfeiterId) {
                const winnerId = Object.keys(rooms[targetRoomId].players).find((id) => id !== forfeiterId);
                endGame(targetRoomId, "forfeit", winnerId, forfeiterId);
            }
            return;
        }
        
        // Fallback for current socket
        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].socketMap && rooms[rID].socketMap[socket.id]) {
                targetRoomId = rID;
                break;
            }
        }
        if (targetRoomId) {
            const pID = rooms[targetRoomId].socketMap[socket.id];
            const winnerId = Object.keys(rooms[targetRoomId].players).find((id) => id !== pID);
            endGame(targetRoomId, "forfeit", winnerId, pID);
        }
    });

    // ===============================================
    //  MOVEMENT & INPUT
    // ===============================================
    function handleInput(socket, data) {
        let rID = data.roomId || data.roomID;

        // Fallback if client didn't send ID
        if (!rID || !rooms[rID]) {
             rID = Object.keys(rooms).find(id => rooms[id].socketMap && rooms[id].socketMap[socket.id]);
        }

        if (rID && rooms[rID]) {
            // FIX: Use the Map to get the persistent ID
            const pID = getPlayerId(rooms[rID], socket.id);
            const player = rooms[rID].players[pID];

            if (player) {
                if (typeof data.x === 'number') player.x = data.x;
                if (typeof data.y === 'number') player.y = data.y;
                if (typeof data.vx === 'number') player.vx = data.vx;
                if (typeof data.vy === 'number') player.vy = data.vy;

                if (data.keys) {
                    player.keys = data.keys;
                }

                if (typeof data.angle !== 'undefined') player.angle = data.angle;
                if (typeof data.shoot !== 'undefined') player.isShooting = data.shoot;
            }
        }
    }

    socket.on("playerUpdate", (data) => handleInput(socket, data));
    socket.on("input", (data) => handleInput(socket, data));

    // ===============================================
    //  SHOOTING & ABILITIES
    // ===============================================
    socket.on("playerShoot", (data) => {
        let rID = data.roomId || data.roomID;
        if (!rID || !rooms[rID]) {
            rID = Object.keys(rooms).find(id => rooms[id].socketMap && rooms[id].socketMap[socket.id]);
        }

        const room = rooms[rID];
        // FIX: Resolve ID
        const pID = getPlayerId(room, socket.id);

        if (!room || !room.players[pID]) {
            return;
        }

        if (Date.now() < room.gameStartTime) return;

        const p = room.players[pID];
        const now = Date.now();
        const slot = data.slot;

        if (!p.cooldowns) p.cooldowns = {};
        if (p.cooldowns[slot] && p.cooldowns[slot] > now) {
            io.to(rID).emit("cooldownUpdate", { id: pID, cooldowns: p.cooldowns });
            return;
        }

        // ============================
        // A. UTILITY LOGIC
        // ============================
        if (slot === "utility") {
            const utilType = p.utility || "dash";
            let cdTime = 0;

            if (utilType === "dash") {
                const dashPower = 30;
                p.vx = Math.cos(p.angle) * dashPower;
                p.vy = Math.sin(p.angle) * dashPower;
                p.speedMult = DASH_MULTIPLIER;

                io.to(room.id).emit("applyBuff", {
                    id: pID, type: "speed", val: p.speedMult, duration: DASH_DURATION,
                });

                setTimeout(() => {
                    if (rooms[rID]?.players[pID]) rooms[rID].players[pID].speedMult = 1.0;
                }, DASH_DURATION);

                cdTime = COOLDOWNS.dash;
            }
            else if (utilType === "shield") {
                p.shield = true;
                cdTime = 0;

                setTimeout(() => {
                    if (rooms[rID]?.players[pID]?.shield) {
                        rooms[rID].players[pID].shield = false;
                        rooms[rID].players[pID].cooldowns.utility = Date.now() + COOLDOWNS.shield;

                        io.to(rID).emit("cooldownUpdate", {
                            id: pID, cooldowns: rooms[rID].players[pID].cooldowns,
                        });
                        io.to(rID).emit("opponentUpdate", { id: pID, shield: false });
                    }
                }, SHIELD_DURATION);
            }
            else if (utilType === "cloak") {
                p.invisible = true;
                cdTime = COOLDOWNS.cloak;
                setTimeout(() => {
                    if (rooms[rID]?.players[pID]) p.invisible = false;
                }, CLOAK_DURATION);
            }
            else if (utilType === "repulse") {
                cdTime = COOLDOWNS.repulse;
                io.to(room.id).emit("visualEffect", { type: "repulse", x: p.x, y: p.y });

                Object.keys(room.players).forEach((otherPID) => {
                    if (otherPID === pID) return;
                    const enemy = room.players[otherPID];
                    const dx = enemy.x - p.x;
                    const dy = enemy.y - p.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < 400) {
                        const angle = Math.atan2(dy, dx);
                        const force = 80;
                        enemy.vx = Math.cos(angle) * force;
                        enemy.vy = Math.sin(angle) * force;
                        // For the pushed player, we find their socket to emit specifically to them if needed
                        // But usually global update handles position. 
                        // If you need to tell the client specifically:
                        // const enemySocketId = Object.keys(room.socketMap).find(key => room.socketMap[key] === otherPID);
                        // if(enemySocketId) io.to(enemySocketId).emit("forcePush", ...);
                    }
                });
            }

            if (utilType !== "shield") {
                p.cooldowns.utility = now + cdTime;
            }
            io.to(room.id).emit("cooldownUpdate", { id: pID, cooldowns: p.cooldowns });
            return;
        }

        // ============================
        // B. WEAPON LOGIC
        // ============================

        if (p.invisible) p.invisible = false;

        const weaponKey = slot === "primary" ? p.primary : p.secondary;
        const stats = WEAPONS[weaponKey] || WEAPONS["pulse"];

        let actualCD = stats.cooldown;
        if (p.perk === "haste") actualCD *= 0.85;
        p.cooldowns[slot] = now + actualCD;

        // --- Mine Logic ---
        if (stats.type === "mine") {
            let actualDamage = stats.damage;
            if (p.perk === "lethality") actualDamage *= 1.15;

            room.bullets.push({
                id: `m_${Date.now()}_${Math.random()}`,
                ownerId: pID, // Use Persistent ID
                x: p.x, y: p.y, angle: 0, speed: 0,
                damage: actualDamage, color: stats.color, range: stats.life,
                traveled: 0, isMine: true, blastRadius: 150, hitList: []
            });
            io.to(room.id).emit("cooldownUpdate", { id: pID, cooldowns: p.cooldowns });
            return;
        }

        // --- Gun Logic ---
        const count = stats.count || 1;
        const spread = stats.spread || 0;
        const spawnDist = PLAYER_RADIUS + 15;

        let startAngle = data.angle;
        if (count > 1) startAngle = data.angle - spread / 2;

        for (let i = 0; i < count; i++) {
            let finalAngle;
            if (count === 1) finalAngle = data.angle;
            else if (spread >= 6.28) finalAngle = data.angle + i * ((Math.PI * 2) / count);
            else finalAngle = startAngle + i * (spread / (count - 1));

            let actualDamage = stats.damage;
            if (p.perk === "lethality") actualDamage = Math.ceil(actualDamage * 1.15);

            room.bullets.push({
                id: `b_${Date.now()}_${Math.random()}`,
                ownerId: pID, // Use Persistent ID
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
                blastDamage: stats.blastDamage || 0,
            });
        }

        io.to(room.id).emit("cooldownUpdate", { id: pID, cooldowns: p.cooldowns });
    });

    // --- RECONNECT / DISCONNECT / LEAVE ---
    socket.on("abandonMatch", () => {
        findRoomAndEnd(socket.id, "draw", null);
    });

    socket.on("leaveGame", () => {
        findRoomAndEnd(socket.id, "forfeit", null);
    });

    // ===============================================
    //  SMART DISCONNECT
    // ===============================================
    socket.on("disconnect", () => {
        io.emit("playerCount", io.engine.clientsCount);
        waitingPlayers = waitingPlayers.filter(s => s.id !== socket.id);

        let roomId = null;
        for (const rID in rooms) {
            // Check Map First
            if (rooms[rID].socketMap && rooms[rID].socketMap[socket.id]) {
                roomId = rID;
                break;
            }
        }

        if (!roomId) return;

        const room = rooms[roomId];
        const pID = getPlayerId(room, socket.id);

        if (!room.players[pID]) return;

        console.log(`[DISCONNECT] Player ${pID} (Socket: ${socket.id}) disconnected from Room ${roomId}`);
        room.players[pID].connected = false;

        const activePlayers = Object.values(room.players).filter(p => p.connected).length;

        if (activePlayers === 0) {
            console.log(`[ROOM] Room ${roomId} is empty. Deleting.`);
            delete rooms[roomId];
        } else {
            console.log(`[ROOM] Room ${roomId} waiting for reconnect.`);
            socket.to(roomId).emit("opponentDisconnected", { id: pID });

            disconnectTimers[pID] = setTimeout(() => {
                if (rooms[roomId] && rooms[roomId].players[pID]) {
                    if (rooms[roomId].players[pID].connected === false) {
                        console.log(`[TIMEOUT] Player ${pID} did not return. Ending game.`);
                        const winnerId = Object.keys(rooms[roomId].players).find(id => id !== pID);
                        endGame(roomId, "opponent_disconnect", winnerId, pID);
                    }
                }
            }, 30000);
        }
    });

    socket.on("ping", (cb) => {
        if (typeof cb === "function") cb();
    });
});

// ==================================================================
// 6. GAME LOOP (The Engine)
// ==================================================================
setInterval(() => {
    const now = Date.now();

    for (const rID in rooms) {
        const room = rooms[rID];

        // 1. CHECK START TIME
        if (now < room.gameStartTime) {
            io.to(rID).emit("gameUpdate", {
                players: room.players,
                bullets: []
            });
            continue;
        }

        // 2. UPDATE PLAYERS (PHYSICS)
        for (const pID in room.players) {
            const p = room.players[pID];
            if (!p.connected) continue;

            if (p.x < 0) p.x = 0;
            if (p.x > MAP_WIDTH) p.x = MAP_WIDTH;
            if (p.y < 0) p.y = 0;
            if (p.y > MAP_HEIGHT) p.y = MAP_HEIGHT;
        }

        // 3. UPDATE BULLETS
        let roomDead = false; // Flag to stop processing if room gets deleted

        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];

            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.traveled += b.speed;

            let removeBullet = false;

            // ... (Your Map Bounds Check here) ...
            if (b.x < -50 || b.x > MAP_WIDTH + 50 || b.y < -50 || b.y > MAP_HEIGHT + 50) {
                removeBullet = true;
            }

            // ... (Your Range Check here) ...
            if (!removeBullet && b.traveled >= b.range && !b.isMine) {
                if (b.explosive) {
                    // FIX: Capture the return value
                    const gameOver = handleExplosion(room, b, b.x, b.y);
                    if (gameOver) {
                        roomDead = true;
                        break; // Stop checking bullets, the room is gone!
                    }
                }
                removeBullet = true;
            }

            // --- C. PLAYER COLLISION ---
            if (!removeBullet && !roomDead) { // Check !roomDead
                for (const pID in room.players) {
                    const p = room.players[pID];

                    if (p.id !== b.ownerId && p.connected && p.hp > 0 && !b.hitList.includes(p.id)) {
                        const dist = Math.sqrt((p.x - b.x) ** 2 + (p.y - b.y) ** 2);

                        if (dist < PLAYER_RADIUS + 10) {
                            
                            // 1. EXPLOSIVE LOGIC
                            if (b.explosive) {
                                // FIX: Capture return value here too
                                const gameOver = handleExplosion(room, b, b.x, b.y);
                                removeBullet = true;
                                if (gameOver) {
                                    roomDead = true; 
                                }
                                break; 
                            }

                            // ... (Your existing Normal Gun Logic) ...
                            // NOTE: If normal guns cause a kill, ensure endGame is called, 
                            // but usually normal guns don't hit multiple targets so the zombie issue is rarer.
                            // ...
                            
                            // (Keep your existing Normal Gun code here)
                            // ...
                        }
                    }
                }
            }

            if (removeBullet) {
                room.bullets.splice(i, 1);
            }
            if (roomDead) break; // Break outer bullet loop
        }

        // --- THE ZOMBIE FIX ---
        // Only send the update if the room actually still exists in memory!
        if (rooms[rID]) {
            io.to(rID).emit("gameUpdate", {
                players: room.players,
                bullets: room.bullets
            });
        }
    }
}, TICK_RATE);


// ===============================================
//  HELPER FUNCTIONS
// ===============================================

function findRoomAndEnd(socketId, reason, winnerId) {
    for (const rID in rooms) {
        // Fix: check map or direct
        const pID = getPlayerId(rooms[rID], socketId);
        if (rooms[rID].players[pID]) {
            endGame(rID, reason, winnerId, null);
            break;
        }
    }
}

function endGame(roomId, reason, winnerId, loserId) {
    if (rooms[roomId]) {
        Object.keys(rooms[roomId].players).forEach((pid) => {
            if (disconnectTimers[pid]) {
                clearTimeout(disconnectTimers[pid]);
                delete disconnectTimers[pid];
            }
        });

        if (!loserId && winnerId) {
            loserId = Object.keys(rooms[roomId].players).find(
                (id) => id !== winnerId
            );
        }

        io.to(roomId).emit("gameOver", {
            winner: reason,
            winnerId: winnerId,
            loserId: loserId,
        });

        console.log(`[GAME OVER] Room ${roomId} ended. Reason: ${reason}`);
        delete rooms[roomId];
    }
}
function handleExplosion(room, bullet, x, y) {
    // 1. Send Visual Effect to Client
    io.to(room.id).emit("visualEffect", { 
        type: "explosion", 
        x: x, 
        y: y, 
        radius: bullet.blastRadius, 
        color: bullet.color 
    });

    let gameEnded = false; // Track if the game ends in this function

    // 2. Check every player in the room
    for (const pID in room.players) {
        const p = room.players[pID];
        if (!p.connected || p.hp <= 0) continue;

        // Calculate Distance
        const dx = p.x - x;
        const dy = p.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // 3. Apply Damage & Physics if inside radius
        if (dist <= bullet.blastRadius) {
            
            // --- FIX FOR BLINK (Rubberbanding) ---
            // We must apply force on the server too, or the client will snap back
            const angle = Math.atan2(dy, dx);
            const force = 15; // Match this with your client-side force
            p.vx += Math.cos(angle) * force;
            p.vy += Math.sin(angle) * force;

            // Calculate Falloff
            const falloff = 1 - (dist / bullet.blastRadius);
            const damage = Math.floor(bullet.blastDamage * falloff);

            if (damage > 0) {
                // Shield Logic
                if (p.shield) {
                    p.shield = false;
                    p.cooldowns.utility = Date.now() + COOLDOWNS.shield;
                    io.to(room.id).emit("damageIndicator", { x: p.x, y: p.y, damage: 0, type: "shield" });
                    io.to(room.id).emit("cooldownUpdate", { id: p.id, cooldowns: p.cooldowns });
                    io.to(room.id).emit("opponentUpdate", { id: p.id, shield: false });
                    continue; 
                }

                // Apply HP Reduction
                p.hp -= damage;

                // Notify Room
                io.to(room.id).emit("playerDamage", { id: p.id, hp: p.hp, damage: damage });
                io.to(room.id).emit("damageIndicator", { x: p.x, y: p.y, damage: damage, type: "blast" });

                // Kill Check
                if (p.hp <= 0) {
                    endGame(room.id, "kill", bullet.ownerId, p.id);
                    gameEnded = true; // Mark that the game has ended
                }
            }
        }
    }
    return gameEnded; // Return the status
}
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
