# BitmorDCA Backend Testing Guide

## Overview

This document provides a comprehensive guide for testing the BitmorDCA backend API endpoints and services. The test suite covers all major functionality including DCA plan creation, payment processing, rewards distribution, and more.

## Test Structure

### Test Files
- `__tests__/bitmorDCA.test.ts` - Main test suite for API endpoints
- `__tests__/setup.ts` - Jest configuration and environment setup

### Test Categories

1. **Health Check Tests**
   - API health endpoint validation

2. **DCA Plan Management**
   - Plan creation with valid signatures
   - Input validation
   - Error handling for missing fields

3. **Payment Processing**
   - Regular payments
   - Prepaid day usage
   - Payment validation

4. **Early Withdrawal**
   - Withdrawal with penalty calculation
   - Validation of withdrawal parameters

5. **Plan Completion**
   - Plan completion verification
   - Signature validation

6. **Rewards System**
   - Reward distribution
   - Reward claiming
   - Array validation

7. **Dust Sweeping**
   - Dust collection and conversion
   - Token array validation

8. **Signature Service**
   - Signature generation
   - Signature verification
   - Nonce generation

## Running Tests

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn

### Installation
```bash
cd backend
npm install
```

### Running Tests

#### Basic Test Run
```bash
npm test
```

#### Watch Mode (for development)
```bash
npm run test:watch
```

#### With Coverage Report
```bash
npm run test:coverage
```

#### Using the Test Script
```bash
chmod +x run-tests.sh
./run-tests.sh
```

## Test Configuration

### Jest Configuration (`jest.config.js`)
- Uses `ts-jest` for TypeScript support
- Test environment: Node.js
- Coverage reporting enabled
- 10-second timeout for tests

### Environment Setup (`__tests__/setup.ts`)
- Mock environment variables
- Console output suppression
- Global test timeout configuration

## Test Data

### Mock Addresses
```typescript
const user = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
const owner = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
const usdc = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
const wbtc = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
const backendSigner = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
```

### Test Private Key
```typescript
const TEST_PRIVATE_KEY = "0x1234567890123456789012345678901234567890123456789012345678901234";
const TEST_CHAIN_ID = 11155111; // Sepolia testnet
```

## API Endpoints Tested

### 1. Health Check
- `GET /api/health`
- Validates API status

### 2. DCA Plan Creation
- `POST /api/dca/create`
- Tests plan creation with signature validation

### 3. Payment Processing
- `POST /api/payments/process`
- Tests payment execution and validation

### 4. Prepay Days
- `POST /api/dca/prepay`
- Tests prepayment functionality

### 5. Early Withdrawal
- `POST /api/dca/withdraw`
- Tests withdrawal with penalty calculation

### 6. Plan Completion
- `POST /api/dca/complete`
- Tests plan completion verification

### 7. Rewards Distribution
- `POST /api/rewards/distribute`
- Tests batch reward distribution

### 8. Claim Rewards
- `POST /api/rewards/claim`
- Tests individual reward claiming

### 9. Dust Sweeping
- `POST /api/dust/sweep`
- Tests dust collection and conversion

## Signature Testing

### Signature Service
The test suite includes comprehensive testing of the `SignatureService` class:

- **Plan Creation Signatures**: Validates signatures for DCA plan creation
- **Payment Signatures**: Tests payment transaction signatures
- **Withdrawal Signatures**: Validates early withdrawal signatures
- **Reward Signatures**: Tests reward distribution signatures
- **Dust Sweep Signatures**: Validates dust collection signatures

### Signature Validation
Each endpoint test includes:
- Valid signature generation
- Invalid signature handling
- Nonce validation
- Chain ID verification

## Error Handling Tests

### Input Validation
- Missing required fields
- Invalid data types
- Array length mismatches
- Invalid addresses

### Business Logic Validation
- Insufficient funds
- Plan completion requirements
- Withdrawal delay enforcement
- Reward eligibility

## Mock Implementation

### Express App Mock
The test suite creates a mock Express application that:
- Simulates real API endpoints
- Validates request parameters
- Returns appropriate responses
- Handles error cases

### Database Mocking
- Uses in-memory data structures
- Simulates database operations
- Validates data consistency

## Coverage Goals

### Target Coverage Areas
- **API Endpoints**: 100% endpoint coverage
- **Signature Service**: 100% method coverage
- **Utility Functions**: 100% function coverage
- **Error Handling**: 90%+ error path coverage

### Coverage Reports
After running `npm run test:coverage`, check:
- `coverage/lcov-report/index.html` - HTML coverage report
- `coverage/lcov.info` - LCOV format for CI/CD

## Continuous Integration

### GitHub Actions Integration
```yaml
name: Backend Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
      - run: npm run test:coverage
```

## Troubleshooting

### Common Issues

1. **TypeScript Compilation Errors**
   ```bash
   npm run build
   ```

2. **Jest Configuration Issues**
   - Check `jest.config.js` syntax
   - Verify TypeScript configuration

3. **Missing Dependencies**
   ```bash
   npm install
   ```

4. **Test Timeout Issues**
   - Increase timeout in `jest.config.js`
   - Check for hanging async operations

### Debug Mode
```bash
npm test -- --verbose
```

## Best Practices

### Writing New Tests
1. Follow the existing test structure
2. Use descriptive test names
3. Test both success and failure cases
4. Validate all response fields
5. Include signature validation where applicable

### Test Data Management
1. Use consistent mock data
2. Clean up test data after each test
3. Use unique identifiers for each test
4. Avoid hardcoded values

### Performance Considerations
1. Mock external dependencies
2. Use efficient test data structures
3. Avoid unnecessary async operations
4. Group related tests together

## Future Enhancements

### Planned Test Improvements
1. **Integration Tests**: Real database and blockchain testing
2. **Load Testing**: Performance and stress testing
3. **Security Testing**: Penetration testing for endpoints
4. **Contract Testing**: Smart contract integration tests

### Test Automation
1. **Automated Test Generation**: Generate tests from API specifications
2. **Visual Regression Testing**: UI component testing
3. **API Contract Testing**: Validate API contracts

## Support

For questions or issues with the test suite:
1. Check this documentation
2. Review test logs and error messages
3. Consult the Jest documentation
4. Create an issue in the project repository
