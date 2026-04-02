const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveUsers(users) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    
    if (users[username]) {
        return res.json({ success: false, message: 'Username already exists' });
    }
    
    users[username] = { password, friends: [], friendRequests: [], pendingRequests: [], messages: {}, active: true };
    saveUsers(users);
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    
    if (users[username] && users[username].password === password) {
        if (!users[username].active) {
            return res.json({ success: false, message: 'Account is deactivated by admin' });
        }
        res.json({ success: true, user: username });
    } else {
        res.json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Invalid admin credentials' });
    }
});

app.get('/api/admin/users', (req, res) => {
    const users = loadUsers();
    const userList = Object.entries(users).map(([name, data]) => ({
        username: name,
        active: data.active !== false,
        friends: data.friends?.length || 0,
        messages: Object.keys(data.messages || {}).length
    }));
    res.json({ users: userList });
});

app.post('/api/admin/toggleUser', (req, res) => {
    const { username, active } = req.body;
    const users = loadUsers();
    
    if (users[username]) {
        users[username].active = active;
        saveUsers(users);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'User not found' });
    }
});

app.delete('/api/admin/user/:username', (req, res) => {
    const users = loadUsers();
    const username = req.params.username;
    
    if (users[username]) {
        delete users[username];
        saveUsers(users);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'User not found' });
    }
});

const onlineUsers = {};
const socketUserMap = {};

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        const users = loadUsers();
        if (!users[username] || users[username].active === false) {
            socket.emit('error', 'Account is deactivated');
            socket.disconnect();
            return;
        }
        
        socketUserMap[socket.id] = username;
        onlineUsers[username] = socket.id;
        
        socket.emit('friendList', users[username]?.friends || []);
        socket.emit('pendingRequests', users[username]?.friendRequests || []);
        
        const onlineList = Object.keys(onlineUsers).filter(u => u !== username);
        socket.emit('onlineUsers', onlineList);
        
        io.emit('userOnline', onlineList);
    });

    socket.on('getChatHistory', (friend) => {
        const username = socketUserMap[socket.id];
        const users = loadUsers();
        const messages = users[username]?.messages?.[friend] || [];
        socket.emit('chatHistory', { friend, messages });
    });

    socket.on('sendFriendRequest', (toUsername) => {
        const fromUsername = socketUserMap[socket.id];
        const users = loadUsers();
        
        if (!users[fromUsername] || !users[toUsername]) return;
        
        const isFriend = users[fromUsername].friends.includes(toUsername);
        const requestSent = users[toUsername].friendRequests.includes(fromUsername);
        
        if (isFriend) {
            socket.emit('requestError', 'Already friends');
            return;
        }
        if (requestSent) {
            socket.emit('requestError', 'Request already sent');
            return;
        }
        
        users[toUsername].friendRequests.push(fromUsername);
        users[toUsername].pendingRequests = users[toUsername].pendingRequests || [];
        users[toUsername].pendingRequests.push(fromUsername);
        
        saveUsers(users);
        
        const toSocket = onlineUsers[toUsername];
        if (toSocket) {
            io.to(toSocket).emit('newFriendRequest', fromUsername);
            io.to(toSocket).emit('pendingRequests', users[toUsername].friendRequests);
        }
        socket.emit('requestSent', toUsername);
    });

    socket.on('acceptFriendRequest', (fromUsername) => {
        const username = socketUserMap[socket.id];
        const users = loadUsers();
        
        if (!users[username] || !users[fromUsername]) return;
        
        if (!users[username].friends.includes(fromUsername)) {
            users[username].friends.push(fromUsername);
            users[fromUsername].friends.push(username);
            
            users[username].friendRequests = users[username].friendRequests.filter(u => u !== fromUsername);
            users[fromUsername].pendingRequests = users[fromUsername].pendingRequests.filter(u => u !== username);
            
            users[username].messages = users[username].messages || {};
            users[username].messages[fromUsername] = users[username].messages[fromUsername] || [];
            users[fromUsername].messages = users[fromUsername].messages || {};
            users[fromUsername].messages[username] = users[fromUsername].messages[username] || [];
            
            saveUsers(users);
            
            socket.emit('friendList', users[username].friends);
            socket.emit('requestAccepted', fromUsername);
            
            const friendSocket = onlineUsers[fromUsername];
            if (friendSocket) {
                io.to(friendSocket).emit('friendList', users[fromUsername].friends);
                io.to(friendSocket).emit('friendRequestAccepted', username);
            }
        }
    });

    socket.on('rejectFriendRequest', (fromUsername) => {
        const username = socketUserMap[socket.id];
        const users = loadUsers();
        
        users[username].friendRequests = users[username].friendRequests.filter(u => u !== fromUsername);
        saveUsers(users);
        
        socket.emit('pendingRequests', users[username].friendRequests);
    });

    socket.on('privateMessage', ({ to, message }) => {
        const from = socketUserMap[socket.id];
        const users = loadUsers();
        
        const isFriend = users[from]?.friends.includes(to);
        if (!isFriend) {
            socket.emit('messageError', 'You can only message friends');
            return;
        }
        
        const msgData = { from, text: message, time: new Date().toLocaleTimeString() };
        
        users[from].messages = users[from].messages || {};
        users[from].messages[to] = users[from].messages[to] || [];
        users[from].messages[to].push(msgData);
        
        users[to].messages = users[to].messages || {};
        users[to].messages[from] = users[to].messages[from] || [];
        users[to].messages[from].push({ from: from, text: message, time: msgData.time });
        
        saveUsers(users);
        
        const toSocket = onlineUsers[to];
        if (toSocket) {
            io.to(toSocket).emit('privateMessage', { from, message, time: msgData.time });
        }
    });

    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        if (username) {
            delete onlineUsers[username];
            delete socketUserMap[socket.id];
            io.emit('userLeft', Object.keys(onlineUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));