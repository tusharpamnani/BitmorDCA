// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/BitmorDCA.sol";

contract BitmorDCAScript is Script {
    // Mainnet addresses
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant cbBTC = 0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2; // Coinbase Layer 2 BTC
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant UNISWAP_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    // Testnet addresses (Goerli)
    address constant USDC_TESTNET = 0x07865c6E87B9F70255377e024ace6630C1Eaa37F;
    address constant cbBTC_TESTNET = 0x1379a7f0bfc346d48508B4b162c37a4c43dd89dc; // Coinbase Layer 2 BTC on Goerli
    address constant AAVE_POOL_TESTNET = 0x368EedF3f56ad10b9bC57eed4Dac65B26Bb667f6;
    address constant UNISWAP_ROUTER_TESTNET = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    function run() external {
        // Get deployment private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address backendSigner = vm.envAddress("BACKEND_SIGNER");

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // Deploy for the active network
        if (block.chainid == 1) {
            // Mainnet deployment
            BitmorDCA dca = new BitmorDCA(
                USDC,
                cbBTC,
                AAVE_POOL,
                UNISWAP_ROUTER,
                backendSigner
            );
            console.log("BitmorDCA deployed to:", address(dca));
            console.log("Network: Mainnet");
        } else {
            // Testnet deployment
            BitmorDCA dca = new BitmorDCA(
                USDC_TESTNET,
                cbBTC_TESTNET,
                AAVE_POOL_TESTNET,
                UNISWAP_ROUTER_TESTNET,
                backendSigner
            );
            console.log("BitmorDCA deployed to:", address(dca));
            console.log("Network: Testnet (Goerli)");
        }

        vm.stopBroadcast();
    }
}
