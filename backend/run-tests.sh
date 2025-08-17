#!/bin/bash

# Run BitmorDCA Backend Tests
echo "🚀 Running BitmorDCA Backend Tests..."

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Run tests
echo "🧪 Running tests..."
npm test

# Run tests with coverage
echo "📊 Running tests with coverage..."
npm run test:coverage

echo "✅ Tests completed!"
