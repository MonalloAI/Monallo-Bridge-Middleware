import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';

// 用 Map 保存 address → socket
const userSockets = new Map<string, WebSocket>();

const wss = new WebSocketServer({ port: 8889 });

wss.on('connection', (ws, req) => {
  const query = parse(req.url!, true).query;
  const address = (query.address as string)?.toLowerCase(); // 标准化地址

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
export function sendToUser(address: string, data: any) {
  const socket = userSockets.get(address.toLowerCase());
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}
