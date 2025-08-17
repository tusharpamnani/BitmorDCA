// Test setup file for Jest
import { ethers } from 'ethers';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.RPC_URL = 'https://sepolia.infura.io/v3/test';
process.env.BACKEND_PRIVATE_KEY = '0x1234567890123456789012345678901234567890123456789012345678901234';
process.env.CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
process.env.CHAINLINK_BTC_FEED = '0x1234567890123456789012345678901234567890';
process.env.AAVE_POOL = '0x1234567890123456789012345678901234567890';
process.env.USDC_ADDRESS = '0x1234567890123456789012345678901234567890';
process.env.CBBTC_ADDRESS = '0x1234567890123456789012345678901234567890';
process.env.BITMOR_API_URL = 'https://api.bitmor.test';
process.env.BITMOR_API_KEY = 'test-api-key';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

// Global test timeout
jest.setTimeout(10000);

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
