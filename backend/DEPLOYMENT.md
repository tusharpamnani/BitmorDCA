# Backend Deployment Guide

This guide explains how to deploy the BitmorDCA backend service.

## Prerequisites

1. Node.js v18 or higher
2. PostgreSQL database
3. Redis instance
4. Environment with the following services available:
   - Ethereum RPC endpoint
   - Chainlink Price Feed access
   - Aave Pool contract
   - USDC and WBTC token contracts

## Environment Setup

1. Create a `.env` file in the backend directory with the following variables:

```env
# Server Configuration
PORT=3000
NODE_ENV=production

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/bitmordca

# Redis
REDIS_URL=redis://localhost:6379

# Blockchain
RPC_URL=your_ethereum_rpc_url
BACKEND_PRIVATE_KEY=your_backend_private_key
CONTRACT_ADDRESS=deployed_contract_address
CHAINLINK_BTC_FEED=chainlink_btc_feed_address
AAVE_POOL=aave_pool_address
USDC_ADDRESS=usdc_token_address
CBBTC_ADDRESS=cbbtc_token_address

# Bitmor Integration
BITMOR_API_URL=bitmor_api_url
BITMOR_API_KEY=your_bitmor_api_key
```

## Database Setup

1. Install PostgreSQL and create a new database:
```bash
createdb bitmordca
```

2. Run Prisma migrations:
```bash
npx prisma migrate deploy
```

## Installation Steps

1. Clone the repository and navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
pnpm install
```

3. Build the project:
```bash
pnpm build
```

## Production Deployment

### Option 1: Docker Deployment

1. Create a Dockerfile:
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy application files
COPY . .

# Run Prisma migrations
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]
```

2. Build and run the Docker container:
```bash
docker build -t bitmordca-backend .
docker run -d --env-file .env -p 3000:3000 bitmordca-backend
```

### Option 2: PM2 Deployment

1. Install PM2 globally:
```bash
npm install -g pm2
```

2. Create a PM2 ecosystem file (ecosystem.config.js):
```javascript
module.exports = {
  apps: [{
    name: 'bitmordca-backend',
    script: 'index.js',
    instances: 'max',
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

3. Start the application with PM2:
```bash
pm2 start ecosystem.config.js
```

### Option 3: Cloud Platform Deployment

#### Heroku Deployment

1. Install Heroku CLI and login:
```bash
npm install -g heroku
heroku login
```

2. Create a new Heroku app:
```bash
heroku create bitmordca-backend
```

3. Add PostgreSQL and Redis add-ons:
```bash
heroku addons:create heroku-postgresql:hobby-dev
heroku addons:create heroku-redis:hobby-dev
```

4. Set environment variables:
```bash
heroku config:set NODE_ENV=production
heroku config:set RPC_URL=your_ethereum_rpc_url
# Set other environment variables...
```

5. Deploy the application:
```bash
git push heroku main
```

## Monitoring and Maintenance

1. Set up logging with Winston:
```javascript
// Add to your index.js
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
```

2. Monitor the application:
- Use PM2 monitoring: `pm2 monit`
- Check logs: `pm2 logs`
- Monitor server resources: `pm2 status`

3. Regular maintenance tasks:
- Monitor database performance
- Check Redis memory usage
- Review error logs
- Monitor API rate limits
- Check blockchain connectivity

## Security Considerations

1. Enable security middleware:
```javascript
// Already included in index.js
app.use(helmet());
app.use(cors());
```

2. Set up SSL/TLS certificates for HTTPS

3. Configure firewall rules to restrict access

4. Regularly update dependencies:
```bash
pnpm update
```

5. Monitor security alerts:
```bash
pnpm audit
```

## Backup and Recovery

1. Set up database backups:
```bash
# For PostgreSQL
pg_dump -Fc bitmordca > backup.dump
```

2. Configure automated backups:
```bash
# Add to crontab
0 0 * * * pg_dump -Fc bitmordca > /backups/bitmordca_$(date +%Y%m%d).dump
```

3. Test recovery procedures:
```bash
pg_restore -d bitmordca backup.dump
```

## Troubleshooting

Common issues and solutions:

1. Database Connection Issues:
- Check DATABASE_URL environment variable
- Verify PostgreSQL is running
- Check network connectivity

2. Redis Connection Issues:
- Verify Redis server is running
- Check REDIS_URL environment variable
- Monitor Redis memory usage

3. Blockchain RPC Issues:
- Check RPC endpoint availability
- Monitor rate limits
- Verify contract addresses

4. Performance Issues:
- Check server resources
- Monitor database query performance
- Review API response times

## Support

For issues and support:
1. Check the error logs in `error.log`
2. Monitor the application logs in `combined.log`
3. Review the Prisma database logs
4. Check the Redis connection status
5. Verify blockchain connectivity
