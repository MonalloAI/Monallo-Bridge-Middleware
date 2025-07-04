import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test';

export const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      // useNewUrlParser: true, 
      // useUnifiedTopology: true, 
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}; 