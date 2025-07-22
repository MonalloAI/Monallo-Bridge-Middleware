"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendToUser = sendToUser;
const ws_1 = require("ws");
const url_1 = require("url");
// 用 Map 保存 address → socket
const userSockets = new Map();
const wss = new ws_1.WebSocketServer({ port: 8888 });
wss.on('connection', (ws, req) => {
    var _a;
    const query = (0, url_1.parse)(req.url, true).query;
    const address = (_a = query.address) === null || _a === void 0 ? void 0 : _a.toLowerCase(); // 标准化地址
    if (!address) {
        ws.close(1008, 'Missing address');
        return;
    }
    console.log(`前端 ${address} 已连接`);
    userSockets.set(address, ws);
    ws.on('close', () => {
        console.log(`前端 ${address} 断开连接`);
        userSockets.delete(address);
    });
});
// 只广播给指定地址的用户
function sendToUser(address, data) {
    const socket = userSockets.get(address.toLowerCase());
    if (socket && socket.readyState === ws_1.WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}
