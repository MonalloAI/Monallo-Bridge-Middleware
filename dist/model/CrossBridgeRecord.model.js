"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const CrossBridgeRecordSchema = new mongoose_1.Schema({
    sourceChainId: { type: Number, required: true },
    sourceChain: { type: String, required: true },
    sourceRpc: { type: String, required: true },
    sourceFromAddress: { type: String, required: true },
    sourceFromTokenName: { type: String, required: true },
    sourceFromTokenContractAddress: { type: String, required: true },
    sourceFromAmount: { type: String, required: true },
    sourceFromHandingFee: { type: String, required: true },
    sourceFromRealAmount: { type: String, required: true },
    sourceFromTxHash: { type: String, required: true },
    sourceFromTxStatus: {
        type: String,
        enum: ['pending', 'failed', 'success'],
        default: 'pending',
    },
    targetChainId: { type: Number, required: true },
    targetChain: { type: String, required: true },
    targetRpc: { type: String, required: true },
    targetToAddress: { type: String, required: true },
    targetToTokenName: { type: String, required: true },
    targetToTokenContractAddress: { type: String, required: true },
    targetToReceiveAmount: { type: String, required: true },
    targetToCallContractAddress: { type: String, required: true },
    targetToGas: { type: String, required: true },
    targetToTxHash: { type: String, required: true },
    targetToTxStatus: {
        type: String,
        enum: ['pending', 'failed', 'success'],
        default: 'pending',
    },
    crossBridgeStatus: {
        type: String,
        enum: ['pending', 'failed', 'minted'],
        default: 'pending',
    },
}, {
    timestamps: true,
});
exports.default = mongoose_1.default.model('CrossBridgeRecord', CrossBridgeRecordSchema);
