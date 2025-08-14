# BitmorDCA

BitmorDCA is a decentralized Dollar Cost Averaging (DCA) platform that allows users to automate their cryptocurrency investments through smart contracts.

## Project Structure

The project consists of three main components:

- `frontend/`: Next.js web application
- `backend/`: Node.js server
- `contract/`: Solidity smart contracts using Foundry

## Prerequisites

- Node.js (v18 or higher)
- pnpm
- Foundry (for smart contract development)
- Git

## Installation

1. Clone the repository:
```bash
git clone https://github.com/tusharpamnani/bitmordca.git
cd bitmordca
```

2. Install Foundry (if not already installed):
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

3. Install dependencies:

For the frontend:
```bash
cd frontend
pnpm install
```

For the backend:
```bash
cd backend
pnpm install
```

For the smart contracts:
```bash
cd contract
forge install
```

## Development Setup

### Smart Contracts

1. Navigate to the contract directory:
```bash
cd contract
```

2. Compile the contracts:
```bash
forge build
```

3. Run tests:
```bash
forge test
```

### Backend

1. Navigate to the backend directory:
```bash
cd backend
```

2. Set up your environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Start the development server:
```bash
pnpm dev
```

### Frontend

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Set up your environment variables:
```bash
cp .env.example .env.local
# Edit .env.local with your configuration
```

3. Start the development server:
```bash
pnpm dev
```

The application will be available at `http://localhost:3000`

## Testing

### Smart Contracts
```bash
cd contract
forge test
```

### Frontend
```bash
cd frontend
pnpm test
```

### Backend
```bash
cd backend
pnpm test
```

## Deployment

### Smart Contracts

1. Set up your deployment environment variables in the contract directory
2. Deploy using Foundry:
```bash
forge script script/BitmorDCA.s.sol:BitmorDCAScript --rpc-url <your-rpc-url> --broadcast
```

### Backend

The backend can be deployed to your preferred hosting service. Make sure to set up the necessary environment variables.

### Frontend

The frontend can be deployed using Vercel or your preferred hosting service:

```bash
cd frontend
pnpm build
pnpm deploy
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
