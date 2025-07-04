import express from 'express';
import { startListening } from './contractEventListener';

const app = express();
const PORT = process.env.PORT || 3001;

startListening();

app.get('/', (_req, res) => {
  res.send('🚀 Server is running, contract listener active!');
});

app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
