import express from 'express';
import { startListening } from './index';
import { startBurnListening } from './burn';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// 添加全局错误处理来捕获 ENS 错误
process.on('uncaughtException', (error) => {
  if (error.message.includes('network does not support ENS')) {
    console.warn('⚠️ ENS 解析错误已被忽略:', error.message);
    return;
  }
  console.error('❌ 未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason && typeof reason === 'object' && 'message' in reason && 
      typeof reason.message === 'string' && reason.message.includes('network does not support ENS')) {
    console.warn('⚠️ ENS 解析错误已被忽略:', reason.message);
    return;
  }
  console.error('❌ 未处理的 Promise 拒绝:', reason);
});

startListening();
startBurnListening();

app.get('/', (_req, res) => {
  res.send('🚀 Server is running, contract listener active!');
});

app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
