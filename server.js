const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// ==================================================================
// 1. SETUP SERVER
// ==================================================================
const app = express();
app.use(cors());

// Optional: Serve static files if hosting from here
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
const PLAYER_SPEED = 5;
const COUNTDOWN_TIME = 3000;

// --- ABILITY CONSTANTS ---
const DASH_DURATION = 500;
const DASH_MULTIPLIER = 2.5;
const CLOAK_DURATION = 5000;
const SHIELD_DURATION = 10000;
const REPULSE_DURATION = 700;

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
    void: { type: "gun", damage: 20, speed: 14, cooldown: 1800, range: 1100, color: "#9900ff", size: 14, explosive: true, blastRadius: 180, blastDamage: 40, desc: "Explosive Launcher" },
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

// ==================================================================
// 5. SOCKET LOGIC
// ==================================================================
io.on("connection", (socket) => {
    console.log(`[CONNECT] User Connected: ${socket.id}`);

    // ===============================================
    //  JOIN QUEUE
    // ===============================================
    socket.on("joinQueue", (data) => {
        // 1. SAVE USER DATA
        if (data) {
            socket.userData = {
                username: data.username ? data.username.substring(0, 15) : "Agent",
                perk: data.perk || "vitality",
                primary: data.primary || "pulse",
                secondary: data.secondary || "pistol",
                utility: data.utility || "dash"
            };
        }

        // 2. CHECK FOR REJOIN TOKEN
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

        // 3. NORMAL QUEUE LOGIC
        if (waitingPlayers.some(s => s.id === socket.id)) return;

        console.log(`[QUEUE] Player ${socket.id} joined queue`);
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

            p1.emit("matchFound", { roomId, playerId: p1.id, players: rooms[roomId].players, matchToken: token1 });
            p2.emit("matchFound", { roomId, playerId: p2.id, players: rooms[roomId].players, matchToken: token2 });

            console.log(`[MATCH] Created Room ${roomId}`);
        }
    });

    // ===============================================
    //  REJOIN GAME
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
            const pData = room.players[oldSocketId];

            if (sock.id !== oldSocketId) {
                room.players[sock.id] = pData;
                room.players[sock.id].id = sock.id;
                delete room.players[oldSocketId];

                if (disconnectTimers[oldSocketId]) {
                    clearTimeout(disconnectTimers[oldSocketId]);
                    delete disconnectTimers[oldSocketId];
                }
            }

            room.players[sock.id].connected = true;
            sock.join(foundRoomId);

            sock.emit("rejoinSuccess", {
                roomId: foundRoomId,
                me: room.players[sock.id],
                players: room.players
            });

            io.to(foundRoomId).emit("opponentStatus", { status: "reconnected", id: sock.id });
        } else {
            sock.emit("rejoinFailed");
        }
    }

    // ===============================================
    //  FORFEIT LOGIC
    // ===============================================
    socket.on("forfeitMatch", (data) => {
        if (data && data.matchToken) {
            const token = data.matchToken;
            let targetRoomId = null;
            let forfeiterId = null;
            for (const rID in rooms) {
                const room = rooms[rID];
                const pID = Object.keys(room.players).find(
                    (id) => room.players[id].matchToken === token
                );
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
        let targetRoomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) {
                targetRoomId = rID;
                break;
            }
        }
        if (targetRoomId) {
            const winnerId = Object.keys(rooms[targetRoomId].players).find((id) => id !== socket.id);
            endGame(targetRoomId, "forfeit", winnerId, socket.id);
        }
    });

    // ===============================================
    //  MOVEMENT & INPUT (SMART FIX APPLIED)
    // ===============================================
    function handleInput(socket, data) {
        // DEBUG: Uncomment to see if raw input is arriving
        // console.log(`[DEBUG_INPUT] ${socket.id} - ${JSON.stringify(data)}`);

        // 1. Try to get Room ID from data, otherwise find it automatically
        let rID = data.roomId || data.roomID;
        
        if (!rID || !rooms[rID]) {
            // Search all rooms to find which one this player is in
            rID = Object.keys(rooms).find(id => rooms[id].players[socket.id]);
        }

        if (rID && rooms[rID] && rooms[rID].players[socket.id]) {
            const player = rooms[rID].players[socket.id];
            
            // Update Keys
            if (data.keys) {
                player.keys = data.keys;
            }

            // Update Aim & State
            if (typeof data.angle !== 'undefined') player.angle = data.angle;
            if (typeof data.shoot !== 'undefined') player.isShooting = data.shoot;
        } else {
            console.log(`[DEBUG_FAIL] Input received but no room found for ${socket.id}`);
        }
    }

    socket.on("playerUpdate", (data) => handleInput(socket, data));
    socket.on("input", (data) => handleInput(socket, data));

    // ===============================================
    //  SHOOTING & ABILITIES (UPDATED WITH DEBUG)
    // ===============================================
    socket.on("playerShoot", (data) => {
        // 1. SMART ROOM FINDING (The Fix)
        let rID = data.roomId || data.roomID;
        if (!rID || !rooms[rID]) {
            rID = Object.keys(rooms).find(id => rooms[id].players[socket.id]);
        }

        const room = rooms[rID];
        
        // Safety check
        if (!room || !room.players[socket.id]) {
            console.log(`[DEBUG_SHOOT_FAIL] No room for ${socket.id}`);
            return;
        }

        // 2. CHECK GAME START
        if (Date.now() < room.gameStartTime) return;

        const p = room.players[socket.id];
        const now = Date.now();
        const slot = data.slot; // "primary", "secondary", or "utility"

        // 3. CHECK COOLDOWNS (AND SYNC CLIENT)
        if (!p.cooldowns) p.cooldowns = {};
        if (p.cooldowns[slot] && p.cooldowns[slot] > now) {
            console.log(`[DEBUG_COOLDOWN] ${slot} rejected for ${socket.id}. Remaining: ${p.cooldowns[slot] - now}`);
            
            // KEY FIX: Tell the client exactly what the server thinks the cooldown is
            io.to(rID).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
            return;
        }

        console.log(`[DEBUG_SHOOT] ${socket.id} fired ${slot}`);

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
                    id: socket.id, type: "speed", val: p.speedMult, duration: DASH_DURATION,
                });

                setTimeout(() => {
                    if (rooms[rID]?.players[socket.id]) rooms[rID].players[socket.id].speedMult = 1.0;
                }, DASH_DURATION);

                cdTime = COOLDOWNS.dash;
            }
            else if (utilType === "shield") {
                p.shield = true;
                cdTime = 0; // Cooldown starts AFTER shield breaks/ends
                
                setTimeout(() => {
                    if (rooms[rID]?.players[socket.id]?.shield) {
                        rooms[rID].players[socket.id].shield = false;
                        rooms[rID].players[socket.id].cooldowns.utility = Date.now() + COOLDOWNS.shield;
                        
                        io.to(rID).emit("cooldownUpdate", {
                            id: socket.id, cooldowns: rooms[rID].players[socket.id].cooldowns,
                        });
                        io.to(rID).emit("opponentUpdate", { id: socket.id, shield: false });
                    }
                }, SHIELD_DURATION);
            }
            else if (utilType === "cloak") {
                p.invisible = true;
                cdTime = COOLDOWNS.cloak;
                setTimeout(() => {
                    if (rooms[rID]?.players[socket.id]) p.invisible = false;
                }, CLOAK_DURATION);
            }
            else if (utilType === "repulse") {
                cdTime = COOLDOWNS.repulse;
                io.to(room.id).emit("visualEffect", { type: "repulse", x: p.x, y: p.y });

                let hitAnyone = false;
                Object.keys(room.players).forEach((pid) => {
                    if (pid === socket.id) return;
                    const enemy = room.players[pid];
                    const dx = enemy.x - p.x;
                    const dy = enemy.y - p.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < 400) {
                        const angle = Math.atan2(dy, dx);
                        const force = 80;
                        enemy.vx = Math.cos(angle) * force;
                        enemy.vy = Math.sin(angle) * force;
                        
                        io.to(pid).emit("forcePush", { angle: angle, force: 30 });
                        hitAnyone = true;
                    }
                });
            }

            // Apply cooldown (Shield handles its own cooldown logic above)
            if (utilType !== "shield") {
                p.cooldowns.utility = now + cdTime;
            }
            io.to(room.id).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
            return;
        }

        // ============================
        // B. WEAPON LOGIC
        // ============================
        
        // Shooting breaks invisibility
        if (p.invisible) p.invisible = false;

        const weaponKey = slot === "primary" ? p.primary : p.secondary;
        const stats = WEAPONS[weaponKey] || WEAPONS["pulse"];

        // Apply Cooldown (Haste Perk reduces it)
        let actualCD = stats.cooldown;
        if (p.perk === "haste") actualCD *= 0.85;
        p.cooldowns[slot] = now + actualCD;

        // --- Mine Logic ---
        if (stats.type === "mine") {
            let actualDamage = stats.damage;
            if (p.perk === "lethality") actualDamage *= 1.15;
            
            room.bullets.push({
                id: `m_${Date.now()}_${Math.random()}`,
                ownerId: socket.id,
                x: p.x, y: p.y, angle: 0, speed: 0,
                damage: actualDamage, color: stats.color, range: stats.life,
                traveled: 0, isMine: true, blastRadius: 150, hitList: []
            });
            io.to(room.id).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
            return;
        }

        // --- Gun Logic ---
        const count = stats.count || 1;
        const spread = stats.spread || 0;
        const spawnDist = PLAYER_RADIUS + 15;
        
        // Calculate starting angle based on spread
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
                blastDamage: stats.blastDamage || 0,
            });
        }

        // Ensure cooldown is synced
        io.to(room.id).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
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
        waitingPlayers = waitingPlayers.filter(s => s.id !== socket.id);

        let roomId = null;
        for (const rID in rooms) {
            if (rooms[rID].players[socket.id]) {
                roomId = rID;
                break;
            }
        }

        if (!roomId) return;

        const room = rooms[roomId];
        if (!room.players[socket.id]) return;

        console.log(`[DISCONNECT] Player ${socket.id} disconnected from Room ${roomId}`);
        room.players[socket.id].connected = false;

        const activePlayers = Object.values(room.players).filter(p => p.connected).length;

        if (activePlayers === 0) {
            console.log(`[ROOM] Room ${roomId} is empty. Deleting.`);
            delete rooms[roomId];
        } else {
            console.log(`[ROOM] Room ${roomId} waiting for reconnect.`);
            io.to(roomId).emit("opponentStatus", { status: "disconnected", id: socket.id });

            disconnectTimers[socket.id] = setTimeout(() => {
                if (rooms[roomId] && rooms[roomId].players[socket.id]) {
                    if (rooms[roomId].players[socket.id].connected === false) {
                        console.log(`[TIMEOUT] Player ${socket.id} did not return. Ending game.`);
                        const winnerId = Object.keys(rooms[roomId].players).find(id => id !== socket.id);
                        endGame(roomId, "opponent_disconnect", winnerId, socket.id);
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

    // Loop through every active room
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

            // --- MOVEMENT LOGIC ---
            let dx = 0;
            let dy = 0;
            
            // Speed calculation
            let speed = PLAYER_SPEED * (p.speedMult || 1.0);
            if (p.isShooting) speed *= 0.6; // Slow down while shooting

            // Handle Input
            if (p.keys) {
                if (p.keys.up || p.keys.w)    dy -= 1;
                if (p.keys.down || p.keys.s)  dy += 1;
                if (p.keys.left || p.keys.a)  dx -= 1;
                if (p.keys.right || p.keys.d) dx += 1;
            }

            // Normalize vector
            if (dx !== 0 || dy !== 0) {
                const length = Math.sqrt(dx * dx + dy * dy);
                dx /= length;
                dy /= length;
                
                // Apply Velocity
                p.x += dx * speed;
                p.y += dy * speed;
            }

            // Apply Knockback / Dash Velocity
            if (Math.abs(p.vx) > 0.1 || Math.abs(p.vy) > 0.1) {
                p.x += p.vx;
                p.y += p.vy;
                p.vx *= 0.9; // Friction
                p.vy *= 0.9;
            } else {
                p.vx = 0;
                p.vy = 0;
            }

            // Map Boundaries
            if (p.x < 0) p.x = 0;
            if (p.x > MAP_WIDTH) p.x = MAP_WIDTH;
            if (p.y < 0) p.y = 0;
            if (p.y > MAP_HEIGHT) p.y = MAP_HEIGHT;
        }

        // 3. UPDATE BULLETS
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            
            // Move bullet
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.traveled += b.speed;

            let removeBullet = false;

            // Range check
            if (b.traveled >= b.range && !b.isMine) {
                removeBullet = true;
            }

            // Wall/Map check
            if (b.x < -50 || b.x > MAP_WIDTH + 50 || b.y < -50 || b.y > MAP_HEIGHT + 50) {
                removeBullet = true;
            }

            // Collision Check (Hit Players)
            if (!removeBullet) {
                for (const pID in room.players) {
                    const p = room.players[pID];
                    // Don't hit self, don't hit disconnected, don't hit already hit (if piercing)
                    if (p.id !== b.ownerId && p.connected && !b.hitList.includes(p.id)) {
                        
                        // Distance formula
                        const dist = Math.sqrt((p.x - b.x) ** 2 + (p.y - b.y) ** 2);
                        
                        if (dist < PLAYER_RADIUS + 10) { // +10 for bullet radius
                            // HIT!
                            
                            // Check Shield
                            if (p.shield) {
                                io.to(rID).emit("damageIndicator", { x: p.x, y: p.y, damage: 0, type: "shield" });
                                removeBullet = true;
                                break;
                            }

                            // Apply Damage
                            p.hp -= b.damage;
                            io.to(rID).emit("damageIndicator", { x: p.x, y: p.y, damage: b.damage, type: "normal" });
                            
                            // Add to hit list (for piercing)
                            b.hitList.push(p.id);

                            // Handle Death
                            if (p.hp <= 0) {
                                const killerId = b.ownerId;
                                endGame(rID, "kill", killerId, p.id);
                                return; // Stop processing this room immediately
                            }

                            if (!b.pierce) {
                                removeBullet = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (removeBullet) {
                room.bullets.splice(i, 1);
            }
        }

        // 4. BROADCAST UPDATE
        io.to(rID).emit("gameUpdate", {
            players: room.players,
            bullets: room.bullets
        });
    }
}, TICK_RATE);


// ===============================================
//  HELPER FUNCTIONS
// ===============================================

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
        // Clear disconnect timers if game ends naturally
        Object.keys(rooms[roomId].players).forEach((pid) => {
            if (disconnectTimers[pid]) {
                clearTimeout(disconnectTimers[pid]);
                delete disconnectTimers[pid];
            }
        });

        // Determine loser if not provided
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

// Start Server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
