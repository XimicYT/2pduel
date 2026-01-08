const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        // Replace with your Netlify URL or "*" to allow any site
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingQueue = [];
let rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join Queue with full Loadout data
    socket.on('joinQueue', (playerData) => {
        // playerData contains: username, class, primary, secondary, utility
        waitingQueue.push({ 
            id: socket.id, 
            ...playerData 
        });

        console.log(`Player ${playerData.username} joined queue.`);

        if (waitingQueue.length >= 2) {
            const p1 = waitingQueue.shift();
            const p2 = waitingQueue.shift();
            const roomID = `room_${p1.id}_${p2.id}`;

            // Create initial game state
            rooms[roomID] = {
                players: {
                    [p1.id]: { x: 100, y: 300, hp: 100, ...p1 },
                    [p2.id]: { x: 700, y: 300, hp: 100, ...p2 }
                }
            };

            const socket1 = io.sockets.sockets.get(p1.id);
            const socket2 = io.sockets.sockets.get(p2.id);

            if (socket1 && socket2) {
                socket1.join(roomID);
                socket2.join(roomID);

                // Send match data to both players (including enemy name for the VS screen)
                io.to(roomID).emit('matchFound', { 
                    roomID, 
                    players: rooms[roomID].players 
                });
            }
        }
    });

    socket.on('playerUpdate', (data) => {
        if (rooms[data.roomID]) {
            rooms[data.roomID].players[socket.id].x = data.x;
            rooms[data.roomID].players[socket.id].y = data.y;
            // Send update to the other person in the room
            socket.to(data.roomID).emit('opponentUpdate', rooms[data.roomID].players[socket.id]);
        }
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(p => p.id !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));