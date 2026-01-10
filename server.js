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
const TICK_RATE = 1000 / 60; // 60 Physics calculations per second
const BROADCAST_RATE = 2; // Normal State: Send updates every 2 ticks (30Hz)

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const PLAYER_RADIUS = 30;
const COUNTDOWN_TIME = 3000; // 3 Seconds before game starts

// --- ABILITY CONSTANTS ---
const DASH_DURATION = 500;
const DASH_MULTIPLIER = 2.5;
const CLOAK_DURATION = 5000;
const SHIELD_DURATION = 10000;
const REPULSE_DURATION = 700; // How long "Pinball Mode" lasts

const COOLDOWNS = {
  rifle: 200, // Fallback
  pistol: 400, // Fallback
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
  pulse: {
    type: "gun",
    damage: 12,
    speed: 22,
    cooldown: 140,
    range: 1100,
    color: "#00f3ff",
    desc: "Standard Rifle",
  },
  rail: {
    type: "gun",
    damage: 40,
    speed: 60,
    cooldown: 1500,
    range: 3000,
    color: "#ff0055",
    pierce: true,
    desc: "Piercing Sniper",
  },
  scatter: {
    type: "gun",
    damage: 7,
    speed: 22,
    cooldown: 850,
    range: 550,
    color: "#ffff00",
    count: 6,
    spread: 0.4,
    desc: "Shotgun",
  },
  void: {
    type: "gun",
    damage: 20,
    speed: 14,
    cooldown: 1800,
    range: 1100,
    color: "#9900ff",
    size: 14,
    explosive: true,
    blastRadius: 180,
    blastDamage: 40,
    desc: "Explosive Launcher",
  },
  twin: {
    type: "gun",
    damage: 8,
    speed: 26,
    cooldown: 60,
    range: 750,
    color: "#00ffaa",
    desc: "Rapid SMG",
  },

  // --- SECONDARY ---
  pistol: {
    type: "gun",
    damage: 14,
    speed: 20,
    cooldown: 300,
    range: 900,
    color: "#cccccc",
    desc: "Sidearm",
  },
  mag: {
    type: "gun",
    damage: 32,
    speed: 30,
    cooldown: 700,
    range: 1200,
    color: "#ffaa00",
    desc: "Heavy Pistol",
  },
  knife: {
    type: "gun",
    damage: 60,
    speed: 35,
    cooldown: 500,
    range: 100,
    color: "#ffffff",
    size: 10,
    desc: "Melee Slash",
  },
  mine: {
    type: "mine",
    damage: 60,
    speed: 0,
    cooldown: 4000,
    range: 9999,
    color: "#ff0000",
    life: 8000,
    desc: "Proximity Mine",
  },

  // --- UTILITIES (Reference) ---
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
let disconnectTimers = {}; // Stores setTimeout IDs

function getDistance(a, b) {
  return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}

// ==================================================================
// 5. SOCKET LOGIC
// ==================================================================
io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // ===============================================
  //  JOIN QUEUE
  // ===============================================
  socket.on("joinQueue", (data) => {
    
    // 1. SAVE USER DATA (Important Fix: Capture Perks/Weapons)
    // If we don't do this, players spawn with defaults
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
      // Search all rooms
      for (const rID in rooms) {
        const room = rooms[rID];
        const pID = Object.keys(room.players).find(
          (id) => room.players[id].matchToken === token
        );
        
        if (pID) {
          // Rejoin Logic specifically handled in 'rejoinGame' or here.
          // Since client might emit 'rejoinGame' separately, we can let that handle it,
          // OR handle it here if the client sends token in joinQueue.
          // For safety, let's trigger the rejoin logic here immediately.
          socket.emit("matchFound", {
             rejoinParams: { token: token } // Client will see this and call rejoinGame?
             // Or we just handle it directly:
          });
          // Better approach: If they have a token, we process it as a rejoin immediately
          // reusing logic similar to rejoinGame below.
          handleRejoin(socket, token);
          return;
        }
      }
    }

    // 3. NORMAL QUEUE LOGIC
    // Check if already in queue
    if (waitingPlayers.some(s => s.id === socket.id)) return;

    console.log(`[QUEUE] Player ${socket.id} joined queue`);
    waitingPlayers.push(socket);

    // Clean queue
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

      // Setup Player Objects using Saved Data
      const p1Data = p1.userData || { username: "P1", perk: "vitality", primary: "pulse", secondary: "pistol", utility: "dash" };
      const p2Data = p2.userData || { username: "P2", perk: "vitality", primary: "pulse", secondary: "pistol", utility: "dash" };

      rooms[roomId] = {
        id: roomId,
        gameStartTime: Date.now() + COUNTDOWN_TIME,
        players: {
          [p1.id]: { 
            id: p1.id, x: 100, y: MAP_HEIGHT/2, 
            hp: 100, maxHp: 100, color: "red", score: 0, connected: true, matchToken: token1,
            cooldowns: {}, angle: 0, vx: 0, vy: 0,
            username: p1Data.username, perk: p1Data.perk,
            primary: p1Data.primary, secondary: p1Data.secondary, utility: p1Data.utility
          },
          [p2.id]: { 
            id: p2.id, x: MAP_WIDTH - 100, y: MAP_HEIGHT/2, 
            hp: 100, maxHp: 100, color: "blue", score: 0, connected: true, matchToken: token2,
            cooldowns: {}, angle: Math.PI, vx: 0, vy: 0,
            username: p2Data.username, perk: p2Data.perk,
            primary: p2Data.primary, secondary: p2Data.secondary, utility: p2Data.utility
          },
        },
        bullets: [],
        tickCount: 0,
        lastUpdate: Date.now(),
      };

      // Apply Vitality Perk
      if(rooms[roomId].players[p1.id].perk === "vitality") {
          rooms[roomId].players[p1.id].maxHp = 130;
          rooms[roomId].players[p1.id].hp = 130;
      }
      if(rooms[roomId].players[p2.id].perk === "vitality") {
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
  //  REJOIN GAME (Explicit Handler)
  // ===============================================
  socket.on("rejoinGame", (data) => {
      handleRejoin(socket, data.token);
  });

  // Helper function to handle logic (shared with joinQueue)
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

         // If socket ID changed (likely), swap them
         if (sock.id !== oldSocketId) {
            room.players[sock.id] = pData;
            room.players[sock.id].id = sock.id;
            delete room.players[oldSocketId];
            
            // Clear old disconnect timer if it exists
            if(disconnectTimers[oldSocketId]) {
                clearTimeout(disconnectTimers[oldSocketId]);
                delete disconnectTimers[oldSocketId];
            }
         }

         room.players[sock.id].connected = true;
         sock.join(foundRoomId);
         
         sock.emit("rejoinSuccess", {
           roomID: foundRoomId,
           me: room.players[sock.id],
           players: room.players
         });
         
         // Notify opponent
         io.to(foundRoomId).emit("opponentStatus", { status: "reconnected", id: sock.id });
         console.log(`[REJOIN] ${pData.username} rejoined Room ${foundRoomId}`);
      } else {
         sock.emit("rejoinFailed");
      }
  }


  // ===============================================
  //  FORFEIT LOGIC
  // ===============================================
  socket.on("forfeitMatch", (data) => {
    // 1. SCENARIO: Forfeit via Token
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
        const winnerId = Object.keys(rooms[targetRoomId].players).find(
          (id) => id !== forfeiterId
        );
        endGame(targetRoomId, "forfeit", winnerId, forfeiterId);
      }
      return; 
    }

    // 2. SCENARIO: Forfeit In-Game
    let targetRoomId = null;
    for (const rID in rooms) {
      if (rooms[rID].players[socket.id]) {
        targetRoomId = rID;
        break;
      }
    }

    if (targetRoomId) {
      const winnerId = Object.keys(rooms[targetRoomId].players).find(
        (id) => id !== socket.id
      );
      endGame(targetRoomId, "forfeit", winnerId, socket.id);
    }
  });

  // ===============================================
  //  MOVEMENT
  // ===============================================
  socket.on("playerUpdate", (data) => {
    if (rooms[data.roomID] && rooms[data.roomID].players[socket.id]) {
      const player = rooms[data.roomID].players[socket.id];
      const room = rooms[data.roomID];
      const isCountdown = Date.now() < room.gameStartTime;

      if (!isCountdown) {
        // Simple smoothing
        player.x = data.x;
        player.y = data.y;
      }
      player.angle = data.angle;
    }
  });

  // ===============================================
  //  SHOOTING & ABILITIES
  // ===============================================
  socket.on("playerShoot", (data) => {
    const room = rooms[data.roomID];
    if (!room || !room.players[socket.id]) return;

    if (Date.now() < room.gameStartTime) return;

    const p = room.players[socket.id];
    const now = Date.now();
    const slot = data.slot;

    if (!p.cooldowns) p.cooldowns = {};
    if (p.cooldowns[slot] && p.cooldowns[slot] > now) return;

    // UTILITY LOGIC
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
          if (rooms[data.roomID]?.players[socket.id]) p.speedMult = 1.0;
        }, DASH_DURATION);

        cdTime = COOLDOWNS.dash;
      } 
      else if (utilType === "shield") {
        p.shield = true;
        cdTime = 0;
        // Auto-expire shield
        setTimeout(() => {
          if (rooms[data.roomID]?.players[socket.id]?.shield) {
            rooms[data.roomID].players[socket.id].shield = false;
            rooms[data.roomID].players[socket.id].cooldowns.utility = Date.now() + COOLDOWNS.shield;
            io.to(data.roomID).emit("cooldownUpdate", {
              id: socket.id, cooldowns: rooms[data.roomID].players[socket.id].cooldowns,
            });
            io.to(data.roomID).emit("opponentUpdate", { id: socket.id, shield: false });
          }
        }, SHIELD_DURATION);
      } 
      else if (utilType === "cloak") {
        p.invisible = true;
        cdTime = COOLDOWNS.cloak;
        setTimeout(() => {
          if (rooms[data.roomID]?.players[socket.id]) p.invisible = false;
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
            enemy.repulseEndTime = Date.now() + REPULSE_DURATION;
            io.to(pid).emit("forcePush", { angle: angle, force: 30 });
            hitAnyone = true;
          }
        });
        if (hitAnyone) broadcastRoomState(room);
      }

      if (utilType !== "shield") {
        p.cooldowns.utility = now + cdTime;
      }
      io.to(room.id).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
      return;
    }

    // WEAPON LOGIC
    if (p.invisible) p.invisible = false;

    const weaponKey = slot === "primary" ? p.primary : p.secondary;
    const stats = WEAPONS[weaponKey] || WEAPONS["pulse"];

    let actualCD = stats.cooldown;
    if (p.perk === "haste") actualCD *= 0.85;
    p.cooldowns[slot] = now + actualCD;

    // Mine Logic
    if (stats.type === "mine") {
      let actualDamage = stats.damage;
      if (p.perk === "lethality") actualDamage *= 1.15;
      room.bullets.push({
        id: `m_${Date.now()}_${Math.random()}`,
        ownerId: socket.id,
        x: p.x, y: p.y, angle: 0, speed: 0,
        damage: actualDamage, color: stats.color, range: stats.life,
        traveled: 0, isMine: true, blastRadius: 150
      });
      io.to(room.id).emit("cooldownUpdate", { id: socket.id, cooldowns: p.cooldowns });
      return;
    }

    // Gun Logic
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
  //  SMART DISCONNECT (Fixed to use disconnectTimers)
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
      // Room empty
      console.log(`[ROOM] Room ${roomId} is empty. Deleting.`);
      delete rooms[roomId];
    } else {
      // Opponent still there
      console.log(`[ROOM] Room ${roomId} waiting for reconnect.`);
      io.to(roomId).emit("opponentStatus", { status: "disconnected", id: socket.id });

      // STORE THE TIMER SO WE CAN CANCEL IT ON REJOIN
      disconnectTimers[socket.id] = setTimeout(() => {
        // Re-check existence
        if (rooms[roomId] && rooms[roomId].players[socket.id]) {
          if (rooms[roomId].players[socket.id].connected === false) {
            console.log(`[TIMEOUT] Player ${socket.id} did not return. Ending game.`);
            const winnerId = Object.keys(rooms[roomId].players).find(id => id !== socket.id);
            endGame(roomId, "opponent_disconnect", winnerId, socket.id);
          }
        }
      }, 30000); // 30 Seconds
    }
  });

  socket.on("ping", (cb) => {
    if (typeof cb === "function") cb();
  });
});

// ==================================================================
// 6. GAME LOOP (PHYSICS & REGEN)
// ==================================================================
setInterval(() => {
  for (const roomId in rooms) {
    updateRoom(rooms[roomId]);
  }
}, TICK_RATE);

function broadcastRoomState(room) {
  const playerIds = Object.keys(room.players);
  if (playerIds.length !== 2) return;

  const p1 = room.players[playerIds[0]];
  const p2 = room.players[playerIds[1]];

  // Send Opponent Data
  io.to(playerIds[1]).emit("opponentUpdate", {
    x: p1.x, y: p1.y, vx: p1.vx, vy: p1.vy,
    angle: p1.angle, invisible: p1.invisible, shield: p1.shield,
  });
  io.to(playerIds[0]).emit("opponentUpdate", {
    x: p2.x, y: p2.y, vx: p2.vx, vy: p2.vy,
    angle: p2.angle, invisible: p2.invisible, shield: p2.shield,
  });

  // Send Self Correction
  io.to(playerIds[0]).emit("selfUpdate", {
    x: p1.x, y: p1.y, vx: p1.vx, vy: p1.vy, hp: p1.hp,
  });
  io.to(playerIds[1]).emit("selfUpdate", {
    x: p2.x, y: p2.y, vx: p2.vx, vy: p2.vy, hp: p2.hp,
  });
}

function updateRoom(room) {
  // FREEZE GAME IF COUNTDOWN IS RUNNING
  if (Date.now() < room.gameStartTime) {
    Object.values(room.players).forEach((p) => {
      p.vx = 0;
      p.vy = 0;
    });
    if (room.tickCount % 10 === 0) broadcastRoomState(room);
    room.tickCount++;
    return;
  }

  const now = Date.now();
  let stateChanged = false;

  room.tickCount = (room.tickCount || 0) + 1;

  // 1. PHYSICS UPDATE FOR PLAYERS
  const playerIds = Object.keys(room.players);
  let highVelocityActive = false;

  playerIds.forEach((pid) => {
    const p = room.players[pid];

    if (Math.abs(p.vx) > 0.1 || Math.abs(p.vy) > 0.1) {
      // --- PINBALL PHYSICS CHECK ---
      const isPinball = p.repulseEndTime && p.repulseEndTime > now;

      // Determine Friction
      let friction = 0.92; 
      if (isPinball) friction = 1.0; 

      // Determine Wall Bounce
      let wallBounce = -0.5; 
      if (isPinball) wallBounce = -1.0; 

      // Adaptive Network Rate
      if (Math.abs(p.vx) > 2 || Math.abs(p.vy) > 2) {
        highVelocityActive = true;
      }

      p.x += p.vx;
      p.y += p.vy;

      p.vx *= friction;
      p.vy *= friction;

      if (!isPinball) {
        if (Math.abs(p.vx) < 0.1) p.vx = 0;
        if (Math.abs(p.vy) < 0.1) p.vy = 0;
      }

      // Map Boundaries
      if (p.x < PLAYER_RADIUS) {
        p.x = PLAYER_RADIUS;
        p.vx *= wallBounce;
      }
      if (p.x > MAP_WIDTH - PLAYER_RADIUS) {
        p.x = MAP_WIDTH - PLAYER_RADIUS;
        p.vx *= wallBounce;
      }
      if (p.y < PLAYER_RADIUS) {
        p.y = PLAYER_RADIUS;
        p.vy *= wallBounce;
      }
      if (p.y > MAP_HEIGHT - PLAYER_RADIUS) {
        p.y = MAP_HEIGHT - PLAYER_RADIUS;
        p.vy *= wallBounce;
      }
    }
  });

  // Send updates
  const shouldBroadcast =
    highVelocityActive || room.tickCount % BROADCAST_RATE === 0;

  if (shouldBroadcast) {
    broadcastRoomState(room);
  }

  // 2. BULLET LOGIC
  if (!room.bullets || room.bullets.length === 0) return;

  let bulletsToRemove = [];
  room.bullets.forEach((b) => {
    // Move Projectiles
    if (!b.isMine) {
      b.x += Math.cos(b.angle) * b.speed;
      b.y += Math.sin(b.angle) * b.speed;
      b.traveled += b.speed;
    } else {
      b.traveled += 16;
    }

    if (
      b.traveled > b.range ||
      b.x < 0 || b.x > MAP_WIDTH ||
      b.y < 0 || b.y > MAP_HEIGHT
    ) {
      bulletsToRemove.push(b.id);
    }

    for (const playerId in room.players) {
      const player = room.players[playerId];
      // Skip self unless it's a mine that has primed (traveled > 500)
      if (playerId === b.ownerId && (!b.isMine || b.traveled < 500)) continue;
      // Skip if already hit (pierce logic)
      if (b.pierce && b.hitList && b.hitList.includes(playerId)) continue;

      if (getDistance(b, player) < PLAYER_RADIUS + 6) {
        if (player.shield) {
          player.shield = false;
          if(!player.cooldowns) player.cooldowns = {};
          
          player.cooldowns.utility = Date.now() + COOLDOWNS.shield;
          io.to(room.id).emit("visualEffect", {
            type: "shieldBreak", x: player.x, y: player.y,
          });
          io.to(room.id).emit("cooldownUpdate", {
            id: playerId, cooldowns: player.cooldowns,
          });
          io.to(room.id).emit("opponentUpdate", {
            id: playerId, x: player.x, y: player.y, angle: player.angle, shield: false,
          });
          bulletsToRemove.push(b.id);
          break;
        } else {
          player.hp -= b.damage;
          player.lastDamageTime = Date.now();

          if (b.explosive) {
            io.to(room.id).emit("visualEffect", { type: "hit", x: b.x, y: b.y }); // Hit effect
            for (const targetId in room.players) {
              if (targetId === b.ownerId) continue;
              const target = room.players[targetId];
              const dist = getDistance({ x: b.x, y: b.y }, target);
              if (dist < b.blastRadius) {
                target.hp -= b.blastDamage;
                target.lastDamageTime = Date.now();
              }
            }
          } else {
             io.to(room.id).emit("visualEffect", { type: "hit", x: b.x, y: b.y });
          }

          io.to(room.id).emit("playerDamage", { id: playerId, hp: player.hp });

          if (player.hp <= 0) {
            endGame(room.id, "kill", b.ownerId, playerId);
            return;
          }

          if (b.pierce) {
            if(!b.hitList) b.hitList = [];
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
    room.bullets = room.bullets.filter((b) => !bulletsToRemove.includes(b.id));
    stateChanged = true;
  }

  if (stateChanged || (room.bullets.length > 0 && shouldBroadcast)) {
    io.to(room.id).emit("projectilesUpdate", room.bullets);
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
    // Clear any pending timers for this room
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
