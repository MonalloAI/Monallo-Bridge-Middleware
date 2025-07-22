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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.manualQueueCheck = manualQueueCheck;
const ethers_1 = require("ethers");
const dotenv = __importStar(require("dotenv"));
const db_1 = require("../db");
const queueChecker_1 = require("./queueChecker");
const LockTokens_json_1 = __importDefault(require("../abi/LockTokens.json"));
const MintTokens_json_1 = __importDefault(require("../abi/MintTokens.json"));
dotenv.config();
const { LOCK_CONTRACT_ADDRESS, MINT_CONTRACT_ADDRESS, PRIVATE_KEY, IMUA_RPC_URL, ETH_RPC_URL, ETH_API_KEY } = process.env;
/**
 * 手动检查队列的工具函数
 * 可以在需要时手动执行，用于处理可能遗漏的消息
 */
function manualQueueCheck() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🚀 开始手动队列检查...');
        try {
            yield (0, db_1.connectDB)();
            console.log('✅ 数据库连接成功');
            // 创建 providers
            const aProvider = new ethers_1.ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
            const bProvider = new ethers_1.ethers.WebSocketProvider(IMUA_RPC_URL);
            const bWallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, bProvider);
            // 创建合约实例
            const lockContract = new ethers_1.ethers.Contract(LOCK_CONTRACT_ADDRESS, LockTokens_json_1.default.abi, aProvider);
            const mintContract = new ethers_1.ethers.Contract(MINT_CONTRACT_ADDRESS, MintTokens_json_1.default.abi, bWallet);
            // 初始化队列检查器
            const queueChecker = new queueChecker_1.QueueChecker({
                mintContract,
                lockTokensContract: lockContract,
                bProvider,
                ethProvider: aProvider
            });
            // 检查待处理队列
            yield queueChecker.checkPendingQueue();
            // 检查过去24小时的失败记录
            yield queueChecker.checkFailedRecords(24);
            console.log('✅ 手动队列检查完成');
        }
        catch (error) {
            console.error('❌ 手动队列检查失败:', error);
        }
    });
}
// 如果直接运行此文件，执行手动检查
if (require.main === module) {
    manualQueueCheck()
        .then(() => {
        console.log('🎉 手动队列检查执行完毕');
        process.exit(0);
    })
        .catch((error) => {
        console.error('💥 手动队列检查执行失败:', error);
        process.exit(1);
    });
}
