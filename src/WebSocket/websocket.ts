import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 8888 });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  console.log('前端 WebSocket 已连接');
  clients.add(ws);

  ws.on('close', () => {
    clients.delete(ws);
    console.log('前端断开连接');
  });
});

// 向所有前端广播
export function broadcastToClients(data: any) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
