import { Document } from 'mongoose';

export interface ILog extends Document {
  address: string;      
  event: 'connect' | 'bridge'; 
  IP: string;              
  Browser: string;         
  System: string;          
  timestamp: Date;         
}
